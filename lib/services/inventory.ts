import type { DbExecutor } from "@/lib/db";
import { ConflictError, ValidationError } from "@/lib/errors";
import type { OrderItemRow, OrderRow } from "@/lib/services/order-types";
import type { SessionUser } from "@/lib/auth/session";

interface LockedProduct {
  id: string;
  sku: string;
  name: string;
  stock_qty: number | string;
  reserved_qty: number | string;
  serial_required: number;
  is_active: number;
}

export interface SerialAssignmentInput {
  orderItemId: string;
  serialNumbers: string[];
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

async function lockProducts(
  query: DbExecutor,
  productIds: string[]
): Promise<Map<string, LockedProduct>> {
  if (productIds.length === 0) return new Map();
  const rows = await query
    .prepare<LockedProduct>(
      `SELECT id, sku, name, stock_qty, reserved_qty, serial_required, is_active
       FROM products
       WHERE id IN (${placeholders(productIds.length)})
       ORDER BY id ASC
       FOR UPDATE`
    )
    .bind(...productIds)
    .all();
  return new Map(rows.map((row) => [String(row.id), row]));
}

function aggregateItems(items: OrderItemRow[]): Map<string, { quantity: number; sku: string }> {
  const result = new Map<string, { quantity: number; sku: string }>();
  for (const item of items) {
    if (!item.product_id) continue;
    const id = String(item.product_id);
    const existing = result.get(id);
    result.set(id, {
      quantity: (existing?.quantity ?? 0) + Number(item.quantity),
      sku: item.sku ?? ""
    });
  }
  return result;
}

/**
 * Giữ tồn kho khi kinh doanh chốt đơn. Khóa product theo thứ tự id để tránh
 * deadlock giữa các đơn đồng thời và kiểm tra khả dụng ngay dưới khóa.
 */
export async function reserveStock(
  query: DbExecutor,
  order: Pick<OrderRow, "id" | "code">,
  items: OrderItemRow[],
  actor: SessionUser,
  ip: string | null
): Promise<void> {
  const aggregates = aggregateItems(items);
  if (aggregates.size === 0) return;
  const ids = [...aggregates.keys()].sort((a, b) => Number(a) - Number(b));
  const products = await lockProducts(query, ids);

  const insufficient: Array<Record<string, unknown>> = [];
  for (const [productId, aggregate] of aggregates) {
    const product = products.get(productId);
    if (!product) {
      insufficient.push({
        productId,
        sku: aggregate.sku,
        reason: "PRODUCT_NOT_FOUND",
        required: aggregate.quantity,
        available: 0
      });
      continue;
    }
    const available = Number(product.stock_qty) - Number(product.reserved_qty);
    if (available < aggregate.quantity) {
      insufficient.push({
        productId,
        sku: product.sku,
        name: product.name,
        required: aggregate.quantity,
        available
      });
    }
  }
  if (insufficient.length > 0) {
    throw new ConflictError(
      "Không đủ tồn kho khả dụng để giữ hàng cho đơn này.",
      { items: insufficient }
    );
  }

  for (const [productId, aggregate] of aggregates) {
    const product = products.get(productId)!;
    const result = await query
      .prepare(
        `UPDATE products
         SET reserved_qty = reserved_qty + ?, version = version + 1, updated_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND stock_qty - reserved_qty >= ?`
      )
      .bind(aggregate.quantity, productId, aggregate.quantity)
      .run();
    if (result.changes !== 1) {
      throw new ConflictError("Tồn kho vừa thay đổi. Vui lòng tải lại đơn và thử lại.");
    }
    const reservedAfter = Number(product.reserved_qty) + aggregate.quantity;
    await query
      .prepare(
        `INSERT INTO inventory_movements
          (product_id, type, quantity_change, reserved_change, stock_after, reserved_after,
           order_id, actor_id, note, created_at)
         VALUES (?, 'RESERVE', 0, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`
      )
      .bind(
        productId,
        aggregate.quantity,
        Number(product.stock_qty),
        reservedAfter,
        order.id,
        actor.id,
        `Giữ hàng cho đơn ${order.code}`
      )
      .run();
  }
}

export interface ConsumptionResult {
  serialsByItem: Record<string, string[]>;
}

/**
 * Xuất kho: giảm stock và reserved, gắn serial vào đúng dòng hàng.
 * Serial phải đang IN_STOCK và chưa được dùng ở bất kỳ đơn nào khác.
 */
export async function consumeStock(
  query: DbExecutor,
  order: Pick<OrderRow, "id" | "code">,
  items: OrderItemRow[],
  serialAssignments: SerialAssignmentInput[] | undefined,
  actor: SessionUser
): Promise<ConsumptionResult> {
  const aggregates = aggregateItems(items);
  if (aggregates.size === 0) {
    if (serialAssignments && serialAssignments.length > 0) {
      throw new ValidationError("Đơn không có hàng hóa cần serial.");
    }
    return { serialsByItem: {} };
  }
  const ids = [...aggregates.keys()].sort((a, b) => Number(a) - Number(b));
  const products = await lockProducts(query, ids);

  for (const [productId, aggregate] of aggregates) {
    const product = products.get(productId);
    if (!product) {
      throw new ValidationError("Có sản phẩm trong đơn không còn tồn tại.", { productId });
    }
    if (Number(product.reserved_qty) < aggregate.quantity) {
      throw new ConflictError("Số lượng giữ hàng không đủ để xuất kho.", {
        productId,
        sku: product.sku,
        required: aggregate.quantity,
        reserved: Number(product.reserved_qty)
      });
    }
    if (Number(product.stock_qty) < aggregate.quantity) {
      throw new ConflictError("Tồn kho thực tế không đủ để xuất kho.", {
        productId,
        sku: product.sku
      });
    }
  }

  const assignmentMap = new Map<string, string[]>();
  if (serialAssignments) {
    for (const assignment of serialAssignments) {
      if (assignmentMap.has(assignment.orderItemId)) {
        throw new ValidationError("Một dòng hàng bị gửi serial trùng.", {
          orderItemId: assignment.orderItemId
        });
      }
      const cleaned = assignment.serialNumbers.map((value) => value.trim()).filter(Boolean);
      if (new Set(cleaned).size !== cleaned.length) {
        throw new ValidationError("Danh sách serial có giá trị trùng.", {
          orderItemId: assignment.orderItemId
        });
      }
      assignmentMap.set(assignment.orderItemId, cleaned);
    }
  }

  const itemIds = new Set(items.map((item) => String(item.id)));
  for (const orderItemId of assignmentMap.keys()) {
    if (!itemIds.has(orderItemId)) {
      throw new ValidationError("Serial được gửi cho dòng hàng không thuộc đơn này.", {
        orderItemId
      });
    }
  }

  // Tập serial cần gắn, kèm product_id kỳ vọng.
  const expectedSerials: Array<{ itemId: string; productId: string; serial: string }> = [];
  for (const item of items) {
    const itemId = String(item.id);
    const provided = assignmentMap.get(itemId);
    if (!item.product_id) {
      if (provided && provided.length > 0) {
        throw new ValidationError("Hàng nhập tay không có serial trong kho.", { orderItemId: itemId });
      }
      continue;
    }
    const product = products.get(String(item.product_id));
    const requiresSerial = Boolean(product?.serial_required);
    if (!requiresSerial) {
      if (provided && provided.length > 0) {
        throw new ValidationError("Sản phẩm này không quản lý serial.", { orderItemId: itemId });
      }
      continue;
    }
    if (!provided || provided.length !== Number(item.quantity)) {
      throw new ConflictError(
        `Sản phẩm ${product?.sku ?? item.sku ?? ""} cần đúng ${item.quantity} serial đang có trong kho.`,
        {
          orderItemId: itemId,
          required: Number(item.quantity),
          provided: provided?.length ?? 0
        }
      );
    }
    for (const serial of provided) {
      expectedSerials.push({
        itemId,
        productId: String(item.product_id),
        serial
      });
    }
  }

  const serialsByItem: Record<string, string[]> = {};
  if (expectedSerials.length > 0) {
    const serialNumbers = expectedSerials.map((entry) => entry.serial);
    if (new Set(serialNumbers.map((value) => value.toLowerCase())).size !== serialNumbers.length) {
      throw new ValidationError("Số serial bị trùng giữa các dòng hàng.");
    }
    const rows = await query
      .prepare<{
        id: string;
        product_id: string;
        serial_number: string;
        status: string;
      }>(
        `SELECT id, product_id, serial_number, status
         FROM stock_serials
         WHERE serial_number IN (${placeholders(serialNumbers.length)})
         ORDER BY id ASC
         FOR UPDATE`
      )
      .bind(...serialNumbers)
      .all();
    const bySerial = new Map(rows.map((row) => [row.serial_number.toLowerCase(), row]));
    for (const expected of expectedSerials) {
      const row = bySerial.get(expected.serial.toLowerCase());
      if (!row || String(row.product_id) !== expected.productId || row.status !== "IN_STOCK") {
        throw new ConflictError(
          `Serial ${expected.serial} không có sẵn trong kho cho sản phẩm này.`,
          {
            serial: expected.serial,
            productId: expected.productId
          }
        );
      }
      await query
        .prepare(
          "UPDATE stock_serials SET status = 'SOLD', updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'IN_STOCK'"
        )
        .bind(row.id)
        .run();
      await query
        .prepare(
          `INSERT INTO order_item_serials (order_item_id, stock_serial_id, serial_number)
           VALUES (?, ?, ?)`
        )
        .bind(expected.itemId, row.id, row.serial_number)
        .run();
      serialsByItem[expected.itemId] = serialsByItem[expected.itemId] ?? [];
      serialsByItem[expected.itemId]!.push(row.serial_number);
    }
  }

  for (const [productId, aggregate] of aggregates) {
    const product = products.get(productId)!;
    const result = await query
      .prepare(
        `UPDATE products
         SET stock_qty = stock_qty - ?, reserved_qty = reserved_qty - ?,
             version = version + 1, updated_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND stock_qty >= ? AND reserved_qty >= ?`
      )
      .bind(
        aggregate.quantity,
        aggregate.quantity,
        productId,
        aggregate.quantity,
        aggregate.quantity
      )
      .run();
    if (result.changes !== 1) {
      throw new ConflictError("Tồn kho vừa thay đổi trong lúc xuất kho. Vui lòng thử lại.");
    }
    const stockAfter = Number(product.stock_qty) - aggregate.quantity;
    const reservedAfter = Number(product.reserved_qty) - aggregate.quantity;
    await query
      .prepare(
        `INSERT INTO inventory_movements
          (product_id, type, quantity_change, reserved_change, stock_after, reserved_after,
           order_id, actor_id, note, created_at)
         VALUES (?, 'SALE', ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`
      )
      .bind(
        productId,
        -aggregate.quantity,
        -aggregate.quantity,
        stockAfter,
        reservedAfter,
        order.id,
        actor.id,
        `Xuất kho cho đơn ${order.code}`
      )
      .run();
  }

  return { serialsByItem };
}

/** Hủy đơn trước khi kho xuất hàng: chỉ giải phóng lượng đang giữ. */
export async function releaseReservedStock(
  query: DbExecutor,
  order: Pick<OrderRow, "id" | "code">,
  items: OrderItemRow[],
  actor: SessionUser
): Promise<void> {
  const aggregates = aggregateItems(items);
  if (aggregates.size === 0) return;
  const ids = [...aggregates.keys()].sort((a, b) => Number(a) - Number(b));
  const products = await lockProducts(query, ids);
  for (const [productId, aggregate] of aggregates) {
    const product = products.get(productId);
    if (!product) continue;
    if (Number(product.reserved_qty) < aggregate.quantity) {
      throw new ConflictError("Dữ liệu giữ kho không nhất quán, không thể hủy đơn.");
    }
    const result = await query
      .prepare(
        `UPDATE products
         SET reserved_qty = reserved_qty - ?, version = version + 1, updated_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND reserved_qty >= ?`
      )
      .bind(aggregate.quantity, productId, aggregate.quantity)
      .run();
    if (result.changes !== 1) {
      throw new ConflictError("Tồn kho vừa thay đổi, không thể hủy đơn.");
    }
    await query
      .prepare(
        `INSERT INTO inventory_movements
          (product_id, type, quantity_change, reserved_change, stock_after, reserved_after,
           order_id, actor_id, note, created_at)
         VALUES (?, 'CANCEL_RELEASE', 0, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`
      )
      .bind(
        productId,
        -aggregate.quantity,
        Number(product.stock_qty),
        Number(product.reserved_qty) - aggregate.quantity,
        order.id,
        actor.id,
        `Hủy đơn ${order.code} - giải phóng giữ kho`
      )
      .run();
  }
}

/**
 * Hủy đơn sau khi kho đã xuất: hoàn hàng vào kho, trả serial về IN_STOCK.
 * Liên kết serial cũ được xóa để serial có thể dùng cho đơn khác; danh sách
 * serial được lưu lại trong metadata của order_event.
 */
export async function restockAfterCancel(
  query: DbExecutor,
  order: Pick<OrderRow, "id" | "code">,
  items: OrderItemRow[],
  actor: SessionUser
): Promise<{ returnedSerials: string[] }> {
  const aggregates = aggregateItems(items);
  const ids = [...aggregates.keys()].sort((a, b) => Number(a) - Number(b));
  const products = await lockProducts(query, ids);
  const returnedSerials: string[] = [];

  const expectedSerialsByItem = new Map<string, number>();
  for (const item of items) {
    if (!item.product_id) continue;
    const product = products.get(String(item.product_id));
    if (product && Number(product.serial_required) === 1) {
      expectedSerialsByItem.set(String(item.id), Number(item.quantity));
    }
  }

  if (ids.length > 0) {
    const serialRows = await query
      .prepare<{ id: string; serial_number: string; order_item_id: string; status: string }>(
        `SELECT ss.id, ss.serial_number, ss.status, ois.order_item_id
         FROM stock_serials ss
         INNER JOIN order_item_serials ois ON ois.stock_serial_id = ss.id
         INNER JOIN order_items oi ON oi.id = ois.order_item_id
         WHERE oi.order_id = ?
         ORDER BY ss.id ASC
         FOR UPDATE`
      )
      .bind(order.id)
      .all();
    const serialCountByItem = new Map<string, number>();
    for (const serial of serialRows) {
      if (serial.status !== "SOLD") {
        throw new ConflictError(
          `Serial ${serial.serial_number} không ở trạng thái đã bán; dữ liệu kho không nhất quán.`
        );
      }
      const itemId = String(serial.order_item_id);
      serialCountByItem.set(itemId, (serialCountByItem.get(itemId) ?? 0) + 1);
      returnedSerials.push(serial.serial_number);
      await query
        .prepare(
          "UPDATE stock_serials SET status = 'IN_STOCK', updated_at = UTC_TIMESTAMP(3) WHERE id = ?"
        )
        .bind(serial.id)
        .run();
      await query
        .prepare("DELETE FROM order_item_serials WHERE stock_serial_id = ?")
        .bind(serial.id)
        .run();
    }
    for (const [itemId, expected] of expectedSerialsByItem) {
      if ((serialCountByItem.get(itemId) ?? 0) !== expected) {
        throw new ConflictError(
          "Số serial đang gắn với đơn không khớp số lượng hàng. Không thể hoàn kho tự động.",
          { orderItemId: itemId, expected, actual: serialCountByItem.get(itemId) ?? 0 }
        );
      }
    }
    for (const [productId, aggregate] of aggregates) {
      const product = products.get(productId);
      if (!product) continue;
      const result = await query
        .prepare(
          `UPDATE products
           SET stock_qty = stock_qty + ?, version = version + 1, updated_at = UTC_TIMESTAMP(3)
           WHERE id = ?`
        )
        .bind(aggregate.quantity, productId)
        .run();
      if (result.changes !== 1) {
        throw new ConflictError("Không thể hoàn tồn kho khi hủy đơn.");
      }
      await query
        .prepare(
          `INSERT INTO inventory_movements
            (product_id, type, quantity_change, reserved_change, stock_after, reserved_after,
             order_id, actor_id, note, created_at)
           VALUES (?, 'CANCEL_RETURN', ?, 0, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`
        )
        .bind(
          productId,
          aggregate.quantity,
          Number(product.stock_qty) + aggregate.quantity,
          Number(product.reserved_qty),
          order.id,
          actor.id,
          `Hủy đơn ${order.code} - hoàn hàng về kho`
        )
        .run();
    }
  }

  return { returnedSerials };
}
