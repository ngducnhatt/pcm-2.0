import type { SessionUser } from "@/lib/auth/session";
import type { SqlValue } from "@/lib/db";
import type { OrderRow } from "@/lib/services/order-types";

export interface AccessScope {
  sql: string;
  params: SqlValue[];
}

/**
 * Phạm vi xem đơn theo vai trò. Kinh doanh/admin xem toàn bộ; các bộ phận
 * chỉ xem đơn đang ở bộ phận mình (shipper chỉ xem đơn được giao).
 * Kế toán xem các đơn đã rời nháp để đối soát doanh thu.
 */
export function orderAccessScope(user: Pick<SessionUser, "role" | "id">, alias = "o"): AccessScope {
  switch (user.role) {
    case "ADMIN":
    case "SALES":
      return { sql: "1 = 1", params: [] };
    case "ACCOUNTANT":
      return { sql: `${alias}.status <> 'DRAFT'`, params: [] };
    case "WAREHOUSE":
      return {
        sql: `${alias}.status IN ('WAREHOUSE_PENDING','WAREHOUSE_IN_PROGRESS')`,
        params: []
      };
    case "TECHNICIAN":
      return {
        sql: `${alias}.status IN ('TECHNICAL_PENDING','TECHNICAL_IN_PROGRESS')`,
        params: []
      };
    case "WARRANTY":
      return {
        sql: `${alias}.status IN ('WARRANTY_PENDING','WARRANTY_IN_PROGRESS')`,
        params: []
      };
    case "SHIPPING_MANAGER":
      return {
        sql: `${alias}.status IN ('DELIVERY_PENDING','DELIVERY_IN_PROGRESS')`,
        params: []
      };
    case "SHIPPER":
      return {
        sql: `${alias}.status = 'DELIVERY_IN_PROGRESS' AND ${alias}.assigned_to_id = ?`,
        params: [user.id]
      };
    default:
      return { sql: "1 = 0", params: [] };
  }
}

export function canViewOrder(user: Pick<SessionUser, "role" | "id">, order: Pick<OrderRow, "status" | "assigned_to_id">): boolean {
  switch (user.role) {
    case "ADMIN":
    case "SALES":
      return true;
    case "ACCOUNTANT":
      return order.status !== "DRAFT";
    case "WAREHOUSE":
      return ["WAREHOUSE_PENDING", "WAREHOUSE_IN_PROGRESS"].includes(order.status);
    case "TECHNICIAN":
      return ["TECHNICAL_PENDING", "TECHNICAL_IN_PROGRESS"].includes(order.status);
    case "WARRANTY":
      return ["WARRANTY_PENDING", "WARRANTY_IN_PROGRESS"].includes(order.status);
    case "SHIPPING_MANAGER":
      return ["DELIVERY_PENDING", "DELIVERY_IN_PROGRESS"].includes(order.status);
    case "SHIPPER":
      return order.status === "DELIVERY_IN_PROGRESS" && order.assigned_to_id === user.id;
    default:
      return false;
  }
}

export function canEditOrder(
  user: Pick<SessionUser, "role" | "id">,
  order: Pick<OrderRow, "status" | "assigned_to_id">
): boolean {
  if (user.role === "ADMIN") return ["DRAFT", "SALES_PENDING", "SALES_IN_PROGRESS"].includes(order.status);
  if (user.role !== "SALES") return false;
  if (order.status === "DRAFT" || order.status === "SALES_PENDING") return true;
  return order.status === "SALES_IN_PROGRESS" && order.assigned_to_id === user.id;
}
