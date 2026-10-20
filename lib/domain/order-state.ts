import {
  type Department,
  type Role,
  DEPARTMENT_QUEUE_SLUGS,
  roleCanAccessQueue
} from "@/lib/domain/roles";

export const ORDER_STATUSES = [
  "DRAFT",
  "SALES_PENDING",
  "SALES_IN_PROGRESS",
  "WAREHOUSE_PENDING",
  "WAREHOUSE_IN_PROGRESS",
  "TECHNICAL_PENDING",
  "TECHNICAL_IN_PROGRESS",
  "WARRANTY_PENDING",
  "WARRANTY_IN_PROGRESS",
  "DELIVERY_PENDING",
  "DELIVERY_IN_PROGRESS",
  "PAYMENT_PENDING",
  "PAYMENT_IN_PROGRESS",
  "COMPLETED",
  "CANCELLED"
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ACTIVE_ORDER_STATUSES: OrderStatus[] = ORDER_STATUSES.filter(
  (status) => !["COMPLETED", "CANCELLED"].includes(status)
);

export const TERMINAL_STATUSES: OrderStatus[] = ["COMPLETED", "CANCELLED"];

export const STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: "Nháp",
  SALES_PENDING: "Chờ kinh doanh xử lý",
  SALES_IN_PROGRESS: "Kinh doanh đang xử lý",
  WAREHOUSE_PENDING: "Chờ kho xử lý",
  WAREHOUSE_IN_PROGRESS: "Kho đang xử lý",
  TECHNICAL_PENDING: "Chờ kỹ thuật xử lý",
  TECHNICAL_IN_PROGRESS: "Kỹ thuật đang xử lý",
  WARRANTY_PENDING: "Chờ bảo hành xử lý",
  WARRANTY_IN_PROGRESS: "Bảo hành đang xử lý",
  DELIVERY_PENDING: "Chờ phân công giao hàng",
  DELIVERY_IN_PROGRESS: "Đang giao hàng",
  PAYMENT_PENDING: "Chờ thanh toán",
  PAYMENT_IN_PROGRESS: "Kế toán đang xử lý",
  COMPLETED: "Hoàn tất",
  CANCELLED: "Đã hủy"
};

export const DEPARTMENT_STATUSES: Record<Department, OrderStatus[]> = {
  SALES: ["SALES_PENDING", "SALES_IN_PROGRESS"],
  WAREHOUSE: ["WAREHOUSE_PENDING", "WAREHOUSE_IN_PROGRESS"],
  TECHNICAL: ["TECHNICAL_PENDING", "TECHNICAL_IN_PROGRESS"],
  WARRANTY: ["WARRANTY_PENDING", "WARRANTY_IN_PROGRESS"],
  DELIVERY: ["DELIVERY_PENDING", "DELIVERY_IN_PROGRESS"],
  PAYMENT: ["PAYMENT_PENDING", "PAYMENT_IN_PROGRESS"]
};

export const PENDING_STATUS_BY_DEPARTMENT: Record<Department, OrderStatus> = {
  SALES: "SALES_PENDING",
  WAREHOUSE: "WAREHOUSE_PENDING",
  TECHNICAL: "TECHNICAL_PENDING",
  WARRANTY: "WARRANTY_PENDING",
  DELIVERY: "DELIVERY_PENDING",
  PAYMENT: "PAYMENT_PENDING"
};

export const IN_PROGRESS_STATUS_BY_DEPARTMENT: Record<Department, OrderStatus> = {
  SALES: "SALES_IN_PROGRESS",
  WAREHOUSE: "WAREHOUSE_IN_PROGRESS",
  TECHNICAL: "TECHNICAL_IN_PROGRESS",
  WARRANTY: "WARRANTY_IN_PROGRESS",
  DELIVERY: "DELIVERY_IN_PROGRESS",
  PAYMENT: "PAYMENT_IN_PROGRESS"
};

export const NEXT_PENDING_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  SALES_IN_PROGRESS: "WAREHOUSE_PENDING",
  WAREHOUSE_IN_PROGRESS: "TECHNICAL_PENDING",
  TECHNICAL_IN_PROGRESS: "WARRANTY_PENDING",
  WARRANTY_IN_PROGRESS: "DELIVERY_PENDING",
  DELIVERY_IN_PROGRESS: "PAYMENT_PENDING",
  PAYMENT_IN_PROGRESS: "COMPLETED"
};

export const ORDER_ACTIONS = [
  "SUBMIT",
  "CLAIM",
  "RELEASE",
  "COMPLETE_SALES",
  "COMPLETE_WAREHOUSE",
  "COMPLETE_TECHNICAL",
  "COMPLETE_WARRANTY",
  "ASSIGN_SHIPPER",
  "REASSIGN_SHIPPER",
  "DELIVERY_FAILED",
  "COMPLETE_DELIVERY",
  "COMPLETE_PAYMENT",
  "CANCEL"
] as const;

export type OrderAction = (typeof ORDER_ACTIONS)[number];

export const ACTION_LABELS: Record<OrderAction, string> = {
  SUBMIT: "Gửi đơn sang kinh doanh",
  CLAIM: "Nhận xử lý",
  RELEASE: "Trả lại hàng đợi",
  COMPLETE_SALES: "Hoàn tất kinh doanh và giữ tồn kho",
  COMPLETE_WAREHOUSE: "Hoàn tất kho, xuất hàng",
  COMPLETE_TECHNICAL: "Hoàn tất kỹ thuật",
  COMPLETE_WARRANTY: "Hoàn tất bảo hành",
  ASSIGN_SHIPPER: "Phân công shipper",
  REASSIGN_SHIPPER: "Đổi shipper",
  DELIVERY_FAILED: "Giao thất bại, trả hàng đợi",
  COMPLETE_DELIVERY: "Xác nhận đã giao hàng",
  COMPLETE_PAYMENT: "Xác nhận hoàn tất thanh toán",
  CANCEL: "Hủy đơn"
};

export const STAGE_BY_STATUS: Partial<Record<OrderStatus, Department>> = {
  DRAFT: "SALES",
  SALES_PENDING: "SALES",
  SALES_IN_PROGRESS: "SALES",
  WAREHOUSE_PENDING: "WAREHOUSE",
  WAREHOUSE_IN_PROGRESS: "WAREHOUSE",
  TECHNICAL_PENDING: "TECHNICAL",
  TECHNICAL_IN_PROGRESS: "TECHNICAL",
  WARRANTY_PENDING: "WARRANTY",
  WARRANTY_IN_PROGRESS: "WARRANTY",
  DELIVERY_PENDING: "DELIVERY",
  DELIVERY_IN_PROGRESS: "DELIVERY",
  PAYMENT_PENDING: "PAYMENT",
  PAYMENT_IN_PROGRESS: "PAYMENT"
};

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export function stageForStatus(status: OrderStatus): Department | null {
  return STAGE_BY_STATUS[status] ?? null;
}

export function queueSlugForStatus(status: OrderStatus): string | null {
  const stage = stageForStatus(status);
  return stage ? DEPARTMENT_QUEUE_SLUGS[stage] : null;
}

export function isTerminalStatus(status: OrderStatus): boolean {
  return status === "COMPLETED" || status === "CANCELLED";
}

export function isPendingStatus(status: OrderStatus): boolean {
  return status.endsWith("_PENDING") || status === "DRAFT";
}

export function stageFromInProgressStatus(status: OrderStatus): Department | null {
  const stage = stageForStatus(status);
  return stage && status.endsWith("_IN_PROGRESS") ? stage : null;
}

export function stageFromPendingStatus(status: OrderStatus): Department | null {
  const stage = stageForStatus(status);
  return stage && status.endsWith("_PENDING") ? stage : null;
}

export interface TransitionActor {
  id: string;
  role: Role;
}

export interface TransitionContext {
  action: OrderAction;
  fromStatus: OrderStatus;
  actor: TransitionActor;
  assignedToId: string | null;
  createdById: string;
}

export interface TransitionDecision {
  allowed: boolean;
  toStatus?: OrderStatus;
  reasonCode?: string;
  message?: string;
}

const ALLOWED = (toStatus: OrderStatus): TransitionDecision => ({ allowed: true, toStatus });
const DENY = (reasonCode: string, message: string): TransitionDecision => ({
  allowed: false,
  reasonCode,
  message
});

const COMPLETE_RULES: Record<
  Exclude<OrderAction, "SUBMIT" | "CLAIM" | "RELEASE" | "ASSIGN_SHIPPER" | "REASSIGN_SHIPPER" | "DELIVERY_FAILED" | "CANCEL">,
  { from: OrderStatus; to: OrderStatus; department: Department }
> = {
  COMPLETE_SALES: { from: "SALES_IN_PROGRESS", to: "WAREHOUSE_PENDING", department: "SALES" },
  COMPLETE_WAREHOUSE: {
    from: "WAREHOUSE_IN_PROGRESS",
    to: "TECHNICAL_PENDING",
    department: "WAREHOUSE"
  },
  COMPLETE_TECHNICAL: {
    from: "TECHNICAL_IN_PROGRESS",
    to: "WARRANTY_PENDING",
    department: "TECHNICAL"
  },
  COMPLETE_WARRANTY: {
    from: "WARRANTY_IN_PROGRESS",
    to: "DELIVERY_PENDING",
    department: "WARRANTY"
  },
  COMPLETE_DELIVERY: {
    from: "DELIVERY_IN_PROGRESS",
    to: "PAYMENT_PENDING",
    department: "DELIVERY"
  },
  COMPLETE_PAYMENT: {
    from: "PAYMENT_IN_PROGRESS",
    to: "COMPLETED",
    department: "PAYMENT"
  }
};

function actorMayActForDepartment(role: Role, department: Department): boolean {
  if (role === "ADMIN") return true;
  if (department === "DELIVERY") {
    // Quản lý ship phân công; shipper chỉ được xác nhận đơn được giao cho mình.
    return role === "SHIPPING_MANAGER" || role === "SHIPPER";
  }
  return roleCanAccessQueue(role, department);
}

function isAssignedToActor(ctx: TransitionContext): boolean {
  return Boolean(ctx.assignedToId) && ctx.assignedToId === ctx.actor.id;
}

/**
 * State machine thuần, không truy cập DB. Các kiểm tra nghiệp vụ nặng hơn
 * (tồn kho, serial, thanh toán, shipper active) nằm trong service/transaction.
 */
export function evaluateTransition(ctx: TransitionContext): TransitionDecision {
  const { action, fromStatus, actor, createdById } = ctx;

  if (action === "SUBMIT") {
    if (fromStatus !== "DRAFT") {
      return DENY("INVALID_STATE", "Chỉ đơn nháp mới được gửi.");
    }
    if (actor.role !== "SALES" && actor.role !== "ADMIN") {
      return DENY("FORBIDDEN", "Chỉ kinh doanh hoặc admin được gửi đơn.");
    }
    return ALLOWED("SALES_PENDING");
  }

  if (action === "CLAIM") {
    const department = stageFromPendingStatus(fromStatus);
    if (!department || department === "DELIVERY") {
      return DENY("INVALID_STATE", "Đơn hiện tại không thể nhận xử lý.");
    }
    if (!actorMayActForDepartment(actor.role, department)) {
      return DENY("FORBIDDEN", "Bạn không thuộc bộ phận đang xử lý đơn này.");
    }
    if (ctx.assignedToId) {
      if (ctx.assignedToId === actor.id) {
        return DENY("ALREADY_CLAIMED", "Bạn đã nhận đơn này rồi.");
      }
      return DENY("ALREADY_CLAIMED", "Đơn đã được người khác nhận xử lý.");
    }
    return ALLOWED(IN_PROGRESS_STATUS_BY_DEPARTMENT[department]);
  }

  if (action === "RELEASE") {
    const department = stageFromInProgressStatus(fromStatus);
    if (!department || department === "DELIVERY") {
      return DENY("INVALID_STATE", "Đơn không ở trạng thái có thể trả hàng đợi.");
    }
    if (!isAssignedToActor(ctx) && actor.role !== "ADMIN") {
      return DENY("FORBIDDEN", "Chỉ người đang xử lý hoặc admin được trả đơn.");
    }
    return ALLOWED(PENDING_STATUS_BY_DEPARTMENT[department]);
  }

  const completeRule = (
    COMPLETE_RULES as Record<string, { from: OrderStatus; to: OrderStatus; department: Department }>
  )[action];

  if (completeRule) {
    if (fromStatus !== completeRule.from) {
      return DENY("INVALID_STATE", "Đơn không ở đúng trạng thái để hoàn tất bước này.");
    }
    const isDelivery = completeRule.department === "DELIVERY";
    if (isDelivery) {
      if (action === "COMPLETE_DELIVERY") {
        if (actor.role !== "ADMIN" && actor.role !== "SHIPPER") {
          return DENY("FORBIDDEN", "Chỉ shipper hoặc admin được xác nhận giao hàng.");
        }
        if (actor.role === "SHIPPER" && !isAssignedToActor(ctx)) {
          return DENY("FORBIDDEN", "Đơn này không được giao cho bạn.");
        }
        return ALLOWED(completeRule.to);
      }
    }
    if (!actorMayActForDepartment(actor.role, completeRule.department)) {
      return DENY("FORBIDDEN", "Bạn không có quyền hoàn tất bước này.");
    }
    if (actor.role !== "ADMIN" && !isAssignedToActor(ctx)) {
      return DENY("NOT_ASSIGNED", "Bạn phải nhận xử lý đơn trước khi hoàn tất.");
    }
    if (action === "COMPLETE_SALES" && actor.role !== "ADMIN" && actor.id !== createdById) {
      // Không bắt buộc người tạo phải là người chốt, nhưng phải là người đã
      // nhận đơn; điều kiện trên đã kiểm tra. Giữ nhánh này để tài liệu hóa.
    }
    return ALLOWED(completeRule.to);
  }

  if (action === "ASSIGN_SHIPPER") {
    if (fromStatus !== "DELIVERY_PENDING") {
      return DENY("INVALID_STATE", "Chỉ phân công khi đơn đang chờ giao hàng.");
    }
    if (actor.role !== "SHIPPING_MANAGER" && actor.role !== "ADMIN") {
      return DENY("FORBIDDEN", "Chỉ quản lý giao hàng hoặc admin được phân công shipper.");
    }
    return ALLOWED("DELIVERY_IN_PROGRESS");
  }

  if (action === "REASSIGN_SHIPPER") {
    if (fromStatus !== "DELIVERY_IN_PROGRESS") {
      return DENY("INVALID_STATE", "Chỉ đổi shipper khi đơn đang giao.");
    }
    if (actor.role !== "SHIPPING_MANAGER" && actor.role !== "ADMIN") {
      return DENY("FORBIDDEN", "Chỉ quản lý giao hàng hoặc admin được đổi shipper.");
    }
    return ALLOWED("DELIVERY_IN_PROGRESS");
  }

  if (action === "DELIVERY_FAILED") {
    if (fromStatus !== "DELIVERY_IN_PROGRESS") {
      return DENY("INVALID_STATE", "Chỉ báo giao thất bại khi đơn đang giao.");
    }
    const allowedRole = actor.role === "ADMIN" || actor.role === "SHIPPING_MANAGER";
    const assignedShipper = actor.role === "SHIPPER" && isAssignedToActor(ctx);
    if (!allowedRole && !assignedShipper) {
      return DENY("FORBIDDEN", "Chỉ shipper được giao hoặc quản lý giao hàng được báo thất bại.");
    }
    return ALLOWED("DELIVERY_PENDING");
  }

  if (action === "CANCEL") {
    const cancellable: OrderStatus[] = [
      "DRAFT",
      "SALES_PENDING",
      "SALES_IN_PROGRESS",
      "WAREHOUSE_PENDING",
      "WAREHOUSE_IN_PROGRESS",
      "TECHNICAL_PENDING",
      "TECHNICAL_IN_PROGRESS",
      "WARRANTY_PENDING",
      "WARRANTY_IN_PROGRESS",
      "DELIVERY_PENDING"
    ];
    if (!cancellable.includes(fromStatus)) {
      return DENY("INVALID_STATE", "Không thể hủy đơn ở trạng thái hiện tại.");
    }
    const salesStage = ["DRAFT", "SALES_PENDING", "SALES_IN_PROGRESS"].includes(fromStatus);
    const allowed = salesStage
      ? actor.role === "SALES" || actor.role === "ADMIN"
      : actor.role === "ADMIN";
    if (!allowed) {
      return DENY("FORBIDDEN", "Chỉ admin được hủy đơn sau khi đã rời bộ phận kinh doanh.");
    }
    return ALLOWED("CANCELLED");
  }

  return DENY("UNKNOWN_ACTION", "Hành động không được hỗ trợ.");
}

/**
 * Gợi ý các thao tác cho UI. Đây chỉ là gợi ý theo state machine; API vẫn
 * kiểm tra đầy đủ quyền và điều kiện nghiệp vụ.
 */
export function availableActionsFor(
  ctx: Omit<TransitionContext, "action">
): OrderAction[] {
  return ORDER_ACTIONS.filter((action) =>
    evaluateTransition({ ...ctx, action }).allowed
  );
}
