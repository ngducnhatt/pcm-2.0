import { getDb, type SqlValue } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/session";
import type { Department } from "@/lib/domain/roles";
import {
  DEPARTMENT_QUEUE_SLUGS,
  DEPARTMENT_LABELS,
  isDepartment,
  QUEUE_TO_DEPARTMENT,
  roleCanAccessQueue,
  type QueueSlug
} from "@/lib/domain/roles";
import {
  DEPARTMENT_STATUSES,
  ORDER_STATUSES,
  STATUS_LABELS,
  stageForStatus,
  type OrderStatus
} from "@/lib/domain/order-state";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  canViewOrder,
  orderAccessScope
} from "@/lib/services/order-access";
import { serializeOrder } from "@/lib/services/order-serializer";
import type {
  DeliveryRow,
  OrderEventRow,
  OrderItemRow,
  OrderNoteRow,
  OrderRow,
  OrderSerialRow,
  PaymentRow
} from "@/lib/services/order-types";
import {
  escapeLike,
  parsePositiveInt,
  safeJsonParse,
  toIsoOrNull
} from "@/lib/utils";

export const ORDER_SELECT = `
  SELECT o.*,
         creator.full_name AS created_by_name,
         assignee.full_name AS assigned_to_name,
         assignee.role AS assigned_to_role,
         (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
  FROM orders o
  LEFT JOIN users creator ON creator.id = o.created_by
  LEFT JOIN users assignee ON assignee.id = o.assigned_to_id
`;

export interface OrderListFilters {
  page: number;
  limit: number;
  status?: OrderStatus;
  q?: string;
  assigned: "me" | "all";
  priority?: "NORMAL" | "HIGH" | "URGENT";
  from?: string;
  to?: string;
  sort: "newest" | "oldest" | "priority" | "updated";
}

export interface QueueFilters {
  page: number;
  limit: number;
  includeDrafts: boolean;
  q?: string;
  sort: "newest" | "oldest" | "priority";
}

function parseId(value: string): string {
  return parsePositiveInt(value)?.toString() ?? "";
}

export async function getOrderDetail(
  orderId: string,
  user: SessionUser,
  options: { bypassAccessCheck?: boolean } = {}
): Promise<Record<string, unknown>> {
  if (!parseId(orderId)) throw new NotFoundError("Không tìm thấy đơn hàng.");
  const db = getDb();
  const row = await db
    .prepare<OrderRow>(`${ORDER_SELECT} WHERE o.id = ? LIMIT 1`)
    .bind(orderId)
    .first();
  if (!row) throw new NotFoundError("Không tìm thấy đơn hàng.");
  if (!options.bypassAccessCheck && !canViewOrder(user, row)) {
    throw new NotFoundError("Không tìm thấy đơn hàng.");
  }

  const items = await db
    .prepare<OrderItemRow>("SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC")
    .bind(orderId)
    .all();
  const serials = await db
    .prepare<OrderSerialRow>(
      `SELECT ois.order_item_id, ois.stock_serial_id, ois.serial_number
       FROM order_item_serials ois
       INNER JOIN order_items oi ON oi.id = ois.order_item_id
       WHERE oi.order_id = ?
       ORDER BY ois.order_item_id, ois.serial_number`
    )
    .bind(orderId)
    .all();
  const notes = await db
    .prepare<OrderNoteRow>(
      `SELECT n.id, n.author_id, u.full_name AS author_name, u.role AS author_role,
              n.department, n.visibility, n.body, n.created_at
       FROM order_notes n
       LEFT JOIN users u ON u.id = n.author_id
       WHERE n.order_id = ?
       ORDER BY n.created_at ASC, n.id ASC`
    )
    .bind(orderId)
    .all();
  const recentEvents = await db
    .prepare<OrderEventRow>(
      `SELECT e.id, e.action, e.from_status, e.to_status, e.actor_id,
              u.full_name AS actor_name, u.role AS actor_role,
              e.note, e.metadata, e.ip, e.created_at
       FROM order_events e
       LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.order_id = ?
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT 100`
    )
    .bind(orderId)
    .all();
  const payments = await db
    .prepare<PaymentRow>(
      `SELECT p.id, p.amount, p.method, p.reference, p.note, p.paid_at,
              p.recorded_by, u.full_name AS recorded_by_name
       FROM payments p
       LEFT JOIN users u ON u.id = p.recorded_by
       WHERE p.order_id = ?
       ORDER BY p.paid_at ASC, p.id ASC`
    )
    .bind(orderId)
    .all();
  const delivery = await db
    .prepare<DeliveryRow>(
      `SELECT d.id, d.shipper_id, u.full_name AS shipper_name, d.assigned_by_id,
              d.status, d.attempt_count, d.assigned_at, d.delivered_at,
              d.receiver_name, d.proof_note, d.failure_reason
       FROM deliveries d
       LEFT JOIN users u ON u.id = d.shipper_id
       WHERE d.order_id = ?
       LIMIT 1`
    )
    .bind(orderId)
    .first();

  return serializeOrder(row, user, {
    items,
    serials,
    notes,
    events: recentEvents.reverse(),
    payments,
    delivery
  });
}

export async function listOrders(
  user: SessionUser,
  filters: OrderListFilters
): Promise<{ orders: Record<string, unknown>[]; total: number }> {
  const db = getDb();
  const scope = orderAccessScope(user);
  const where: string[] = [scope.sql];
  const params: SqlValue[] = [...scope.params];

  if (filters.status) {
    where.push("o.status = ?");
    params.push(filters.status);
  }
  if (filters.priority) {
    where.push("o.priority = ?");
    params.push(filters.priority);
  }
  if (filters.assigned === "me") {
    where.push("o.assigned_to_id = ?");
    params.push(user.id);
  }
  if (filters.q) {
    const term = `%${escapeLike(filters.q)}%`;
    where.push(
      "(o.code LIKE ? ESCAPE '\\\\' OR o.customer_name LIKE ? ESCAPE '\\\\' OR o.customer_phone LIKE ? ESCAPE '\\\\')"
    );
    params.push(term, term, term);
  }
  if (filters.from) {
    where.push("o.created_at >= ?");
    params.push(`${filters.from} 00:00:00.000`);
  }
  if (filters.to) {
    where.push("o.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(`${filters.to} 00:00:00.000`);
  }

  const whereSql = where.join(" AND ");
  const countRow = await db
    .prepare<{ total: number | string }>(`SELECT COUNT(*) AS total FROM orders o WHERE ${whereSql}`)
    .bind(...params)
    .first();
  const total = Number(countRow?.total ?? 0);

  const sortSql =
    filters.sort === "oldest"
      ? "o.created_at ASC, o.id ASC"
      : filters.sort === "updated"
        ? "o.updated_at DESC, o.id DESC"
        : filters.sort === "priority"
          ? "FIELD(o.priority, 'URGENT', 'HIGH', 'NORMAL'), o.created_at DESC"
          : "o.created_at DESC, o.id DESC";
  const offset = (filters.page - 1) * filters.limit;
  const rows = await db
    .prepare<OrderRow>(
      `${ORDER_SELECT} WHERE ${whereSql} ORDER BY ${sortSql} LIMIT ? OFFSET ?`
    )
    .bind(...params, filters.limit, offset)
    .all();

  return {
    orders: rows.map((row) => serializeOrder(row, user)),
    total
  };
}

export async function getQueue(
  slug: string,
  user: SessionUser,
  filters: QueueFilters
): Promise<{
  department: Department;
  departmentLabel: string;
  orders: Record<string, unknown>[];
  total: number;
  counts: Record<string, number>;
}> {
  if (!Object.values(DEPARTMENT_QUEUE_SLUGS).includes(slug as QueueSlug)) {
    throw new ValidationError("Bộ phận không hợp lệ.");
  }
  const department = QUEUE_TO_DEPARTMENT[slug as QueueSlug];
  if (!roleCanAccessQueue(user.role, department)) {
    throw new ForbiddenError("Bạn không có quyền xem hàng đợi này.");
  }

  let statuses: OrderStatus[] = [...DEPARTMENT_STATUSES[department]];
  if (department === "SALES" && filters.includeDrafts) {
    statuses = ["DRAFT", ...statuses];
  }
  if (user.role === "SHIPPER" && department === "DELIVERY") {
    statuses = ["DELIVERY_IN_PROGRESS"];
  }

  const db = getDb();
  const scope = orderAccessScope(user);
  const params: SqlValue[] = [...scope.params];
  let where = `${scope.sql} AND o.status IN (${statuses.map(() => "?").join(",")})`;
  params.push(...statuses);

  if (filters.q) {
    const term = `%${escapeLike(filters.q)}%`;
    where +=
      " AND (o.code LIKE ? ESCAPE '\\\\' OR o.customer_name LIKE ? ESCAPE '\\\\' OR o.customer_phone LIKE ? ESCAPE '\\\\')";
    params.push(term, term, term);
  }

  const countRow = await db
    .prepare<{ total: number | string }>(`SELECT COUNT(*) AS total FROM orders o WHERE ${where}`)
    .bind(...params)
    .first();
  const total = Number(countRow?.total ?? 0);

  const sortSql =
    filters.sort === "oldest"
      ? "o.stage_entered_at ASC, o.id ASC"
      : filters.sort === "newest"
        ? "o.stage_entered_at DESC, o.id DESC"
        : "FIELD(o.priority, 'URGENT', 'HIGH', 'NORMAL'), o.stage_entered_at ASC";
  const offset = (filters.page - 1) * filters.limit;
  const rows = await db
    .prepare<OrderRow>(
      `${ORDER_SELECT} WHERE ${where} ORDER BY ${sortSql} LIMIT ? OFFSET ?`
    )
    .bind(...params, filters.limit, offset)
    .all();

  const countRows = await db
    .prepare<{ status: OrderStatus; total: number | string }>(
      `SELECT o.status, COUNT(*) AS total
       FROM orders o
       WHERE ${scope.sql} AND o.status IN (${statuses.map(() => "?").join(",")})
       GROUP BY o.status`
    )
    .bind(...scope.params, ...statuses)
    .all();
  const counts: Record<string, number> = {};
  for (const status of ORDER_STATUSES) counts[status] = 0;
  for (const row of countRows) counts[row.status] = Number(row.total);

  return {
    department,
    departmentLabel: DEPARTMENT_LABELS[department],
    orders: rows.map((row) => serializeOrder(row, user)),
    total,
    counts
  };
}

export async function getOrderHistory(
  orderId: string,
  user: SessionUser,
  page: number,
  limit: number
): Promise<{
  history: Record<string, unknown>[];
  total: number;
}> {
  const row = await getOrderDetail(orderId, user);
  const db = getDb();
  const totalRow = await db
    .prepare<{ total: number | string }>("SELECT COUNT(*) AS total FROM order_events WHERE order_id = ?")
    .bind(orderId)
    .first();
  const rows = await db
    .prepare<OrderEventRow>(
      `SELECT e.id, e.action, e.from_status, e.to_status, e.actor_id,
              u.full_name AS actor_name, u.role AS actor_role,
              e.note, e.metadata, e.ip, e.created_at
       FROM order_events e
       LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.order_id = ?
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ? OFFSET ?`
    )
    .bind(orderId, limit, (page - 1) * limit)
    .all();
  const ordered = rows.reverse();
  return {
    history: ordered.map((event) => {
      // Tái sử dụng serializer chi tiết qua một order tối thiểu là không cần;
      // chỉ trả các trường lịch sử an toàn, bỏ metadata tài chính cho vai trò kho.
      return {
        id: String(event.id),
        action: event.action,
        fromStatus: event.from_status,
        toStatus: event.to_status,
        actor: event.actor_name
          ? { id: event.actor_id, fullName: event.actor_name, role: event.actor_role }
          : null,
        note: event.note,
        metadata:
          ["ADMIN", "SALES", "ACCOUNTANT"].includes(user.role) ||
          user.role === "WAREHOUSE"
            ? safeJsonParse<unknown>(event.metadata, null)
            : undefined,
        createdAt: toIsoOrNull(event.created_at)
      };
    }),
    total: Number(totalRow?.total ?? 0)
  };
}

export async function getDashboard(user: SessionUser): Promise<Record<string, unknown>> {
  const db = getDb();
  const scope = orderAccessScope(user);
  const rows = await db
    .prepare<{ status: OrderStatus; total: number | string }>(
      `SELECT o.status, COUNT(*) AS total FROM orders o WHERE ${scope.sql} GROUP BY o.status`
    )
    .bind(...scope.params)
    .all();
  const counts: Record<string, number> = {};
  for (const status of ORDER_STATUSES) counts[status] = 0;
  for (const row of rows) counts[row.status] = Number(row.total);

  const unreadRow = await db
    .prepare<{ total: number | string }>(
      "SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND read_at IS NULL"
    )
    .bind(user.id)
    .first();

  const result: Record<string, unknown> = {
    role: user.role,
    counts,
    unreadNotifications: Number(unreadRow?.total ?? 0),
    queues: Object.fromEntries(
      Object.entries(DEPARTMENT_STATUSES)
        .filter(([department]) => roleCanAccessQueue(user.role, department as Department))
        .map(([department, statuses]) => [
          DEPARTMENT_QUEUE_SLUGS[department as Department],
          statuses.reduce((sum, status) => sum + (counts[status] ?? 0), 0)
        ])
    )
  };

  if (["ADMIN", "SALES", "ACCOUNTANT"].includes(user.role)) {
    const revenue = await db
      .prepare<{ total: string | null; paid: string | null }>(
        `SELECT COALESCE(SUM(o.total_amount), 0.00) AS total,
                COALESCE(SUM(o.paid_amount), 0.00) AS paid
         FROM orders o
         WHERE ${scope.sql} AND o.status = 'COMPLETED'`
      )
      .bind(...scope.params)
      .first();
    result.revenue = {
      completedOrderTotal: revenue?.total ?? "0.00",
      completedPaidTotal: revenue?.paid ?? "0.00"
    };
  }

  return result;
}

export function assertStatusCoherent(status: string): asserts status is OrderStatus {
  if (!(ORDER_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Trạng thái đơn không hợp lệ: ${status}`);
  }
  const stage = stageForStatus(status as OrderStatus);
  if (stage && !isDepartment(stage)) {
    throw new Error(`Bộ phận không hợp lệ cho trạng thái ${status}`);
  }
}

export { STATUS_LABELS };
