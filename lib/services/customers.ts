import { z } from "zod";
import type { NextRequest } from "next/server";
import { getDb, isDuplicateKeyError, withTransaction } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/session";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { serializeCustomer } from "@/lib/services/order-serializer";
import { writeAudit } from "@/lib/services/audit";
import { getRequestContext } from "@/lib/http/request";
import { emailSchema, normalizePhone, phoneSchema } from "@/lib/validation";
import { escapeLike, generateCustomerCode, parsePositiveInt } from "@/lib/utils";

export const createCustomerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: phoneSchema,
  email: emailSchema.optional(),
  address: z.string().trim().min(5).max(500),
  note: z.string().trim().max(1000).optional()
});

export const updateCustomerSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: phoneSchema.optional(),
    email: emailSchema.nullable().optional(),
    address: z.string().trim().min(5).max(500).optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    isActive: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, "Không có dữ liệu cập nhật.");

export const customerListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  active: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

interface CustomerRow {
  id: string;
  code: string;
  full_name: string;
  phone: string;
  email: string | null;
  address: string;
  note: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export async function listCustomers(input: z.infer<typeof customerListQuerySchema>): Promise<{
  customers: Record<string, unknown>[];
  total: number;
}> {
  const db = getDb();
  const where: string[] = ["1 = 1"];
  const params: Array<string | number> = [];
  if (input.q) {
    const term = `%${escapeLike(input.q)}%`;
    where.push(
      "(code LIKE ? ESCAPE '\\\\' OR full_name LIKE ? ESCAPE '\\\\' OR phone LIKE ? ESCAPE '\\\\')"
    );
    params.push(term, term, term);
  }
  if (input.active) {
    where.push("is_active = ?");
    params.push(input.active === "true" ? 1 : 0);
  }
  const whereSql = where.join(" AND ");
  const total = await db
    .prepare<{ total: number | string }>(`SELECT COUNT(*) AS total FROM customers WHERE ${whereSql}`)
    .bind(...params)
    .first();
  const rows = await db
    .prepare<CustomerRow>(
      `SELECT * FROM customers WHERE ${whereSql}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    )
    .bind(...params, input.limit, (input.page - 1) * input.limit)
    .all();
  return {
    customers: rows.map(serializeCustomer),
    total: Number(total?.total ?? 0)
  };
}

export async function getCustomer(customerId: string): Promise<Record<string, unknown>> {
  if (!parsePositiveInt(customerId)) throw new NotFoundError("Không tìm thấy khách hàng.");
  const row = await getDb()
    .prepare<CustomerRow>("SELECT * FROM customers WHERE id = ? LIMIT 1")
    .bind(customerId)
    .first();
  if (!row) throw new NotFoundError("Không tìm thấy khách hàng.");
  return serializeCustomer(row);
}

export async function createCustomer(
  request: NextRequest,
  user: SessionUser,
  input: z.infer<typeof createCustomerSchema>
): Promise<Record<string, unknown>> {
  const meta = getRequestContext(request);
  const phone = normalizePhone(input.phone);
  try {
    const id = await withTransaction(async (query) => {
      const result = await query
        .prepare(
          `INSERT INTO customers
             (code, full_name, phone, email, address, note, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
        )
        .bind(
          generateCustomerCode(),
          input.fullName,
          phone,
          input.email ?? null,
          input.address,
          input.note ?? null,
          user.id
        )
        .run();
      const customerId = String(result.lastInsertId);
      await writeAudit(query, { id: user.id, fullName: user.fullName }, {
        action: "CUSTOMER_CREATED",
        entityType: "CUSTOMER",
        entityId: customerId,
        after: {
          code: undefined,
          fullName: input.fullName,
          phone,
          email: input.email,
          address: input.address
        },
        ip: meta.ip,
        userAgent: meta.userAgent
      });
      return customerId;
    });
    return getCustomer(id);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new ConflictError("Số điện thoại đã tồn tại.");
    throw error;
  }
}

export async function updateCustomer(
  request: NextRequest,
  user: SessionUser,
  customerId: string,
  input: z.infer<typeof updateCustomerSchema>
): Promise<Record<string, unknown>> {
  if (!parsePositiveInt(customerId)) throw new NotFoundError("Không tìm thấy khách hàng.");
  const meta = getRequestContext(request);
  try {
    await withTransaction(async (query) => {
      const current = await query
        .prepare<CustomerRow>("SELECT * FROM customers WHERE id = ? FOR UPDATE")
        .bind(customerId)
        .first();
      if (!current) throw new NotFoundError("Không tìm thấy khách hàng.");
      const fields: string[] = [];
      const params: Array<string | number | null> = [];
      if (input.fullName !== undefined) {
        fields.push("full_name = ?");
        params.push(input.fullName);
      }
      if (input.phone !== undefined) {
        const phone = normalizePhone(input.phone);
        if (!phone) throw new ValidationError("Số điện thoại không hợp lệ.");
        fields.push("phone = ?");
        params.push(phone);
      }
      if (input.email !== undefined) {
        fields.push("email = ?");
        params.push(input.email ?? null);
      }
      if (input.address !== undefined) {
        fields.push("address = ?");
        params.push(input.address);
      }
      if (input.note !== undefined) {
        fields.push("note = ?");
        params.push(input.note ?? null);
      }
      if (input.isActive !== undefined) {
        fields.push("is_active = ?");
        params.push(input.isActive ? 1 : 0);
      }
      if (fields.length === 0) return;
      fields.push("updated_at = UTC_TIMESTAMP(3)");
      params.push(customerId);
      await query
        .prepare(`UPDATE customers SET ${fields.join(", ")} WHERE id = ?`)
        .bind(...params)
        .run();
      const updated = await query
        .prepare<CustomerRow>("SELECT * FROM customers WHERE id = ? LIMIT 1")
        .bind(customerId)
        .first();
      await writeAudit(query, { id: user.id, fullName: user.fullName }, {
        action: "CUSTOMER_UPDATED",
        entityType: "CUSTOMER",
        entityId: customerId,
        before: serializeCustomer(current),
        after: updated ? serializeCustomer(updated) : input,
        ip: meta.ip,
        userAgent: meta.userAgent
      });
    });
    return getCustomer(customerId);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new ConflictError("Số điện thoại đã tồn tại.");
    throw error;
  }
}
