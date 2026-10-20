import { z } from "zod";
import type { NextRequest } from "next/server";
import { getDb, isDuplicateKeyError, withTransaction } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/session";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/services/audit";
import { getRequestContext } from "@/lib/http/request";
import { moneyInputSchema } from "@/lib/validation";
import { escapeLike, parsePositiveInt, toIsoOrNull } from "@/lib/utils";

export const createProductSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(1000).optional(),
  category: z.string().trim().max(80).optional(),
  unit: z.string().trim().min(1).max(20).default("cái"),
  costPrice: moneyInputSchema.default("0"),
  salePrice: moneyInputSchema.default("0"),
  minStock: z.coerce.number().int().min(0).max(1_000_000).default(0),
  serialRequired: z.boolean().default(false)
});

export const updateProductSchema = z
  .object({
    expectedVersion: z.coerce.number().int().min(0),
    sku: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    category: z.string().trim().max(80).nullable().optional(),
    unit: z.string().trim().min(1).max(20).optional(),
    costPrice: moneyInputSchema.optional(),
    salePrice: moneyInputSchema.optional(),
    minStock: z.coerce.number().int().min(0).max(1_000_000).optional(),
    serialRequired: z.boolean().optional(),
    isActive: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"), "Không có dữ liệu cập nhật.");

export const productListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(80).optional(),
  active: z.enum(["true", "false"]).optional(),
  lowStock: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export const stockAdjustmentSchema = z.object({
  expectedVersion: z.coerce.number().int().min(0),
  quantityDelta: z.coerce.number().int().min(-1_000_000).max(1_000_000).refine((value) => value !== 0, "Số lượng điều chỉnh phải khác 0."),
  reason: z.string().trim().min(3).max(1000),
  serialNumbers: z.array(z.string().trim().min(1).max(190)).max(5000).optional()
});

export const serialListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["IN_STOCK", "RESERVED", "SOLD", "DEFECTIVE"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  unit: string;
  cost_price: string;
  sale_price: string;
  stock_qty: number;
  reserved_qty: number;
  min_stock: number;
  serial_required: number;
  is_active: number;
  version: number;
  created_at: string;
  updated_at: string;
}

function serializeProduct(row: ProductRow, includeCost: boolean): Record<string, unknown> {
  return {
    id: String(row.id),
    sku: row.sku,
    name: row.name,
    description: row.description,
    category: row.category,
    unit: row.unit,
    ...(includeCost ? { costPrice: row.cost_price } : {}),
    salePrice: row.sale_price,
    stockQty: Number(row.stock_qty),
    reservedQty: Number(row.reserved_qty),
    availableQty: Number(row.stock_qty) - Number(row.reserved_qty),
    minStock: Number(row.min_stock),
    serialRequired: Boolean(row.serial_required),
    isActive: Boolean(row.is_active),
    version: Number(row.version),
    createdAt: toIsoOrNull(row.created_at),
    updatedAt: toIsoOrNull(row.updated_at)
  };
}

export async function listProducts(
  user: SessionUser,
  input: z.infer<typeof productListQuerySchema>
): Promise<{ products: Record<string, unknown>[]; total: number }> {
  const db = getDb();
  const where: string[] = ["1 = 1"];
  const params: Array<string | number> = [];
  if (input.q) {
    const term = `%${escapeLike(input.q)}%`;
    where.push("(sku LIKE ? ESCAPE '\\\\' OR name LIKE ? ESCAPE '\\\\')");
    params.push(term, term);
  }
  if (input.category) {
    where.push("category = ?");
    params.push(input.category);
  }
  if (input.active) {
    where.push("is_active = ?");
    params.push(input.active === "true" ? 1 : 0);
  }
  if (input.lowStock === "true") {
    where.push("(stock_qty - reserved_qty) <= min_stock");
  }
  const whereSql = where.join(" AND ");
  const total = await db
    .prepare<{ total: number | string }>(`SELECT COUNT(*) AS total FROM products WHERE ${whereSql}`)
    .bind(...params)
    .first();
  const rows = await db
    .prepare<ProductRow>(
      `SELECT * FROM products WHERE ${whereSql}
       ORDER BY is_active DESC, name ASC, id ASC LIMIT ? OFFSET ?`
    )
    .bind(...params, input.limit, (input.page - 1) * input.limit)
    .all();
  const includeCost = ["ADMIN", "ACCOUNTANT"].includes(user.role);
  return {
    products: rows.map((row) => serializeProduct(row, includeCost)),
    total: Number(total?.total ?? 0)
  };
}

export async function getProduct(
  user: SessionUser,
  productId: string
): Promise<Record<string, unknown>> {
  if (!parsePositiveInt(productId)) throw new NotFoundError("Không tìm thấy sản phẩm.");
  const row = await getDb()
    .prepare<ProductRow>("SELECT * FROM products WHERE id = ? LIMIT 1")
    .bind(productId)
    .first();
  if (!row) throw new NotFoundError("Không tìm thấy sản phẩm.");
  return serializeProduct(row, ["ADMIN", "ACCOUNTANT"].includes(user.role));
}

export async function createProduct(
  request: NextRequest,
  user: SessionUser,
  input: z.infer<typeof createProductSchema>
): Promise<Record<string, unknown>> {
  const meta = getRequestContext(request);
  try {
    const result = await withTransaction(async (query) => {
      const insert = await query
        .prepare(
          `INSERT INTO products
            (sku, name, description, category, unit, cost_price, sale_price,
             stock_qty, reserved_qty, min_stock, serial_required, is_active, created_by,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 1, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
        )
        .bind(
          input.sku,
          input.name,
          input.description ?? null,
          input.category ?? null,
          input.unit,
          input.costPrice,
          input.salePrice,
          input.minStock,
          input.serialRequired ? 1 : 0,
          user.id
        )
        .run();
      const id = String(insert.lastInsertId);
      await writeAudit(query, { id: user.id, fullName: user.fullName }, {
        action: "PRODUCT_CREATED",
        entityType: "PRODUCT",
        entityId: id,
        after: {
          sku: input.sku,
          name: input.name,
          salePrice: input.salePrice,
          serialRequired: input.serialRequired
        },
        ip: meta.ip,
        userAgent: meta.userAgent
      });
      return id;
    });
    return getProduct(user, result);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new ConflictError("SKU đã tồn tại.");
    throw error;
  }
}

export async function updateProduct(
  request: NextRequest,
  user: SessionUser,
  productId: string,
  input: z.infer<typeof updateProductSchema>
): Promise<Record<string, unknown>> {
  const meta = getRequestContext(request);
  try {
    await withTransaction(async (query) => {
      const current = await query
        .prepare<ProductRow>("SELECT * FROM products WHERE id = ? FOR UPDATE")
        .bind(productId)
        .first();
      if (!current) throw new NotFoundError("Không tìm thấy sản phẩm.");
      if (Number(current.version) !== input.expectedVersion) {
        throw new ConflictError("Sản phẩm đã được cập nhật. Vui lòng tải lại.", {
          currentVersion: Number(current.version)
        });
      }
      if (input.serialRequired !== undefined && input.serialRequired !== Boolean(current.serial_required)) {
        if (Number(current.stock_qty) > 0) {
          throw new ConflictError("Không thể đổi cách quản lý serial khi sản phẩm còn tồn kho.");
        }
      }
      const fields: string[] = [];
      const params: Array<string | number | null> = [];
      const mapping: Array<[keyof typeof input, string]> = [
        ["sku", "sku"],
        ["name", "name"],
        ["description", "description"],
        ["category", "category"],
        ["unit", "unit"],
        ["costPrice", "cost_price"],
        ["salePrice", "sale_price"],
        ["minStock", "min_stock"]
      ];
      for (const [key, column] of mapping) {
        const value = input[key];
        if (value !== undefined) {
          fields.push(`${column} = ?`);
          params.push(value as string | number | null);
        }
      }
      if (input.serialRequired !== undefined) {
        fields.push("serial_required = ?");
        params.push(input.serialRequired ? 1 : 0);
      }
      if (input.isActive !== undefined) {
        fields.push("is_active = ?");
        params.push(input.isActive ? 1 : 0);
      }
      fields.push("version = version + 1", "updated_at = UTC_TIMESTAMP(3)");
      params.push(productId);
      const result = await query
        .prepare(`UPDATE products SET ${fields.join(", ")} WHERE id = ? AND version = ?`)
        .bind(...params, Number(current.version))
        .run();
      if (result.changes !== 1) throw new ConflictError("Sản phẩm vừa thay đổi, vui lòng tải lại.");
      const updated = await query
        .prepare<ProductRow>("SELECT * FROM products WHERE id = ? LIMIT 1")
        .bind(productId)
        .first();
      await writeAudit(query, { id: user.id, fullName: user.fullName }, {
        action: "PRODUCT_UPDATED",
        entityType: "PRODUCT",
        entityId: productId,
        before: serializeProduct(current, true),
        after: updated ? serializeProduct(updated, true) : input,
        ip: meta.ip,
        userAgent: meta.userAgent
      });
    });
    return getProduct(user, productId);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new ConflictError("SKU đã tồn tại.");
    throw error;
  }
}

export async function adjustStock(
  request: NextRequest,
  user: SessionUser,
  productId: string,
  input: z.infer<typeof stockAdjustmentSchema>
): Promise<Record<string, unknown>> {
  const meta = getRequestContext(request);
  await withTransaction(async (query) => {
    const product = await query
      .prepare<ProductRow>("SELECT * FROM products WHERE id = ? FOR UPDATE")
      .bind(productId)
      .first();
    if (!product) throw new NotFoundError("Không tìm thấy sản phẩm.");
    if (Number(product.version) !== input.expectedVersion) {
      throw new ConflictError("Sản phẩm đã thay đổi. Vui lòng tải lại.", {
        currentVersion: Number(product.version)
      });
    }
    const delta = input.quantityDelta;
    const serialNumbers = (input.serialNumbers ?? []).map((value) => value.trim()).filter(Boolean);
    if (new Set(serialNumbers.map((value) => value.toLowerCase())).size !== serialNumbers.length) {
      throw new ValidationError("Danh sách serial bị trùng.");
    }
    if (Boolean(product.serial_required)) {
      if (serialNumbers.length !== Math.abs(delta)) {
        throw new ValidationError(
          `Sản phẩm quản lý serial cần đúng ${Math.abs(delta)} serial cho điều chỉnh này.`
        );
      }
    } else if (serialNumbers.length > 0) {
      throw new ValidationError("Sản phẩm này không quản lý serial.");
    }

    const newStock = Number(product.stock_qty) + delta;
    const newReserved = Number(product.reserved_qty);
    if (newStock < 0 || newReserved > newStock) {
      throw new ConflictError("Không thể điều chỉnh vì tồn kho không đủ hoặc đang giữ cho đơn khác.");
    }

    if (Boolean(product.serial_required)) {
      if (delta > 0) {
        for (const serial of serialNumbers) {
          await query
            .prepare(
              `INSERT INTO stock_serials
                 (product_id, serial_number, status, notes, created_by, created_at, updated_at)
               VALUES (?, ?, 'IN_STOCK', ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
            )
            .bind(productId, serial, input.reason, user.id)
            .run();
        }
      } else {
        const rows = await query
          .prepare<{ id: string; serial_number: string }>(
            `SELECT id, serial_number FROM stock_serials
             WHERE product_id = ? AND serial_number IN (${serialNumbers.map(() => "?").join(",")})
               AND status = 'IN_STOCK'
             ORDER BY id ASC FOR UPDATE`
          )
          .bind(productId, ...serialNumbers)
          .all();
        if (rows.length !== serialNumbers.length) {
          throw new ConflictError("Có serial không tồn tại hoặc không còn IN_STOCK.");
        }
        for (const row of rows) {
          await query
            .prepare(
              "UPDATE stock_serials SET status = 'DEFECTIVE', notes = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?"
            )
            .bind(input.reason, row.id)
            .run();
        }
      }
    }

    const update = await query
      .prepare(
        `UPDATE products SET stock_qty = ?, version = version + 1, updated_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND version = ?`
      )
      .bind(newStock, productId, Number(product.version))
      .run();
    if (update.changes !== 1) throw new ConflictError("Sản phẩm vừa thay đổi, vui lòng tải lại.");
    await query
      .prepare(
        `INSERT INTO inventory_movements
          (product_id, type, quantity_change, reserved_change, stock_after, reserved_after,
           actor_id, note, created_at)
         VALUES (?, 'ADJUSTMENT', ?, 0, ?, ?, ?, ?, UTC_TIMESTAMP(3))`
      )
      .bind(productId, delta, newStock, newReserved, user.id, input.reason)
      .run();
    await writeAudit(query, { id: user.id, fullName: user.fullName }, {
      action: "PRODUCT_STOCK_ADJUSTED",
      entityType: "PRODUCT",
      entityId: productId,
      before: { stockQty: Number(product.stock_qty), version: Number(product.version) },
      after: { stockQty: newStock, version: Number(product.version) + 1 },
      metadata: { quantityDelta: delta, reason: input.reason, serialNumbers },
      ip: meta.ip,
      userAgent: meta.userAgent
    });
  });
  return getProduct(user, productId);
}

export async function listProductSerials(
  productId: string,
  input: z.infer<typeof serialListQuerySchema>
): Promise<{ serials: Record<string, unknown>[]; total: number }> {
  if (!parsePositiveInt(productId)) throw new NotFoundError("Không tìm thấy sản phẩm.");
  const db = getDb();
  const where: string[] = ["product_id = ?"];
  const params: Array<string | number> = [productId];
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  }
  if (input.q) {
    where.push("serial_number LIKE ? ESCAPE '\\\\'");
    params.push(`%${escapeLike(input.q)}%`);
  }
  const whereSql = where.join(" AND ");
  const total = await db
    .prepare<{ total: number | string }>(
      `SELECT COUNT(*) AS total FROM stock_serials WHERE ${whereSql}`
    )
    .bind(...params)
    .first();
  const rows = await db
    .prepare<{
      id: string;
      serial_number: string;
      status: string;
      notes: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, serial_number, status, notes, created_at, updated_at
       FROM stock_serials WHERE ${whereSql}
       ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .bind(...params, input.limit, (input.page - 1) * input.limit)
    .all();
  return {
    serials: rows.map((row) => ({
      id: String(row.id),
      serialNumber: row.serial_number,
      status: row.status,
      notes: row.notes,
      createdAt: toIsoOrNull(row.created_at),
      updatedAt: toIsoOrNull(row.updated_at)
    })),
    total: Number(total?.total ?? 0)
  };
}
