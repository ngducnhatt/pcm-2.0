import type { SessionUser } from "@/lib/auth/session";
import {
  ACTION_LABELS,
  availableActionsFor,
  stageForStatus,
  STATUS_LABELS
} from "@/lib/domain/order-state";
import {
  DEPARTMENT_LABELS,
  departmentForRole,
  isDepartment,
  ROLE_LABELS,
  type Department
} from "@/lib/domain/roles";
import type {
  DeliveryRow,
  OrderDetailExtras,
  OrderEventRow,
  OrderItemRow,
  OrderNoteRow,
  OrderRow,
  OrderSerialRow,
  PaymentRow
} from "@/lib/services/order-types";
import { safeJsonParse, toIsoOrNull } from "@/lib/utils";
import { canEditOrder } from "@/lib/services/order-access";
import { subtractMoney } from "@/lib/domain/money";

const FINANCE_ROLES = new Set(["ADMIN", "SALES", "ACCOUNTANT"]);
const DELIVERY_ROLES = new Set(["ADMIN", "SALES", "SHIPPING_MANAGER", "SHIPPER"]);
const CONTACT_ROLES = new Set(["ADMIN", "SALES", "SHIPPING_MANAGER", "SHIPPER", "ACCOUNTANT"]);
const ADDRESS_ROLES = new Set(["ADMIN", "SALES", "SHIPPING_MANAGER", "SHIPPER"]);
const EMAIL_ROLES = new Set(["ADMIN", "SALES", "ACCOUNTANT"]);
const ITEM_PRICE_ROLES = new Set(["ADMIN", "SALES", "ACCOUNTANT"]);
const SERIAL_ITEM_ROLES = new Set(["ADMIN", "SALES", "WAREHOUSE", "TECHNICIAN", "WARRANTY"]);
const NOTE_AUTHOR_FINANCE = new Set(["ADMIN", "SALES", "ACCOUNTANT"]);

const STATUS_PAYMENT_LABELS: Record<string, string> = {
  UNPAID: "Chưa thanh toán",
  PARTIAL: "Thanh toán một phần",
  PAID: "Đã thanh toán đủ"
};

const PRIORITY_LABELS: Record<string, string> = {
  NORMAL: "Bình thường",
  HIGH: "Cao",
  URGENT: "Khẩn cấp"
};

const ACTION_FALLBACK_LABELS: Record<string, string> = {
  CREATE: "Tạo đơn",
  UPDATE: "Cập nhật đơn",
  PAYMENT_RECORDED: "Ghi nhận thanh toán",
  NOTE_ADDED: "Thêm ghi chú",
  DELIVERY_ASSIGNED: "Phân công giao hàng"
};

function iso(value: string | null | undefined): string | null {
  return toIsoOrNull(value);
}

function canViewSerialForRole(role: string): boolean {
  return SERIAL_ITEM_ROLES.has(role);
}

function canViewFinancials(role: string): boolean {
  return FINANCE_ROLES.has(role);
}

function canViewDelivery(role: string): boolean {
  return DELIVERY_ROLES.has(role) || role === "ACCOUNTANT";
}

export function serializeOrder(
  row: OrderRow,
  viewer: SessionUser,
  extras: OrderDetailExtras = {}
): Record<string, unknown> {
  const finance = canViewFinancials(viewer.role);
  const contact = CONTACT_ROLES.has(viewer.role);
  const address = ADDRESS_ROLES.has(viewer.role);
  const email = EMAIL_ROLES.has(viewer.role);
  const department: Department | null = isDepartment(row.current_department ?? "")
    ? (row.current_department as Department)
    : stageForStatus(row.status);
  const detailExtras = extras;

  const output: Record<string, unknown> = {
    id: String(row.id),
    code: row.code,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] ?? row.status,
    department: department ?? null,
    departmentLabel: department ? DEPARTMENT_LABELS[department] : null,
    priority: row.priority,
    priorityLabel: PRIORITY_LABELS[row.priority] ?? row.priority,
    version: Number(row.version),
    customer: {
      fullName: row.customer_name,
      ...(contact ? { phone: row.customer_phone } : {}),
      ...(email && row.customer_email ? { email: row.customer_email } : {}),
      ...(address ? { address: row.shipping_address } : {})
    },
    expectedDeliveryDate: row.expected_delivery_date,
    warrantyMonths: Number(row.warranty_months),
    warrantyUntil: row.warranty_until,
    createdBy: row.created_by_name
      ? { id: String(row.created_by), fullName: row.created_by_name }
      : { id: String(row.created_by) },
    assignedTo: row.assigned_to_id
      ? {
          id: String(row.assigned_to_id),
          fullName: row.assigned_to_name,
          role: row.assigned_to_role,
          roleLabel: row.assigned_to_role ? ROLE_LABELS[row.assigned_to_role] : null
        }
      : null,
    stageEnteredAt: iso(row.stage_entered_at),
    shippedAt: iso(row.shipped_at),
    deliveredAt: iso(row.delivered_at),
    completedAt: iso(row.completed_at),
    cancelledAt: iso(row.cancelled_at),
    ...(finance ? { cancellationReason: row.cancellation_reason } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    itemCount: row.item_count !== undefined ? Number(row.item_count) : undefined,
    canEdit: canEditOrder(viewer, row),
    allowedActions: availableActionsFor({
      fromStatus: row.status,
      actor: { id: viewer.id, role: viewer.role },
      assignedToId: row.assigned_to_id,
      createdById: String(row.created_by)
    })
  };

  if (finance) {
    output.totals = {
      subtotal: row.subtotal_amount,
      discount: row.discount_amount,
      shippingFee: row.shipping_fee,
      total: row.total_amount,
      paid: row.paid_amount,
      remaining: subtractMoney(row.total_amount, row.paid_amount),
      paymentStatus: row.payment_status,
      paymentStatusLabel: STATUS_PAYMENT_LABELS[row.payment_status] ?? row.payment_status,
      paymentMethod: row.payment_method
    };
  } else if (DELIVERY_ROLES.has(viewer.role)) {
    output.collection = {
      total: row.total_amount,
      paid: row.paid_amount,
      remaining: subtractMoney(row.total_amount, row.paid_amount),
      paymentStatus: row.payment_status,
      paymentStatusLabel: STATUS_PAYMENT_LABELS[row.payment_status] ?? row.payment_status
    };
  }

  if (detailExtras.items) {
    output.items = serializeItems(detailExtras.items, detailExtras.serials ?? [], viewer);
  }
  if (detailExtras.notes) {
    output.notes = detailExtras.notes
      .filter((note) => canViewNote(note, viewer))
      .map(serializeNote);
  }
  if (detailExtras.events) {
    output.history = detailExtras.events.map((event) => serializeEvent(event, viewer));
  }
  if (detailExtras.payments && finance) {
    output.payments = detailExtras.payments.map(serializePayment);
  }
  if (detailExtras.delivery && canViewDelivery(viewer.role)) {
    output.delivery = serializeDelivery(detailExtras.delivery);
  }

  return output;
}

function serializeItems(
  items: OrderItemRow[],
  serials: OrderSerialRow[],
  viewer: SessionUser
): Array<Record<string, unknown>> {
  const serialsByItem = new Map<string, string[]>();
  if (canViewSerialForRole(viewer.role)) {
    for (const serial of serials) {
      const list = serialsByItem.get(String(serial.order_item_id)) ?? [];
      list.push(serial.serial_number);
      serialsByItem.set(String(serial.order_item_id), list);
    }
  }
  const priceVisible = ITEM_PRICE_ROLES.has(viewer.role);
  return items.map((item) => ({
    id: String(item.id),
    productId: item.product_id ? String(item.product_id) : null,
    sku: item.sku,
    name: item.name,
    quantity: Number(item.quantity),
    ...(priceVisible
      ? { unitPrice: item.unit_price, lineTotal: item.line_total }
      : {}),
    serialRequired: Boolean(item.serial_required),
    ...(canViewSerialForRole(viewer.role)
      ? { serials: serialsByItem.get(String(item.id)) ?? [] }
      : {}),
    notes: item.notes
  }));
}

export function canViewNote(note: OrderNoteRow, viewer: SessionUser): boolean {
  if (viewer.role === "ADMIN") return true;
  if (note.visibility === "ALL") return true;
  if (note.visibility === "PRIVATE") return note.author_id === viewer.id;
  if (note.visibility === "DEPARTMENT") {
    const department = departmentForRole(viewer.role);
    return Boolean(department && note.department === department);
  }
  return false;
}

function serializeNote(note: OrderNoteRow): Record<string, unknown> {
  return {
    id: String(note.id),
    author: note.author_name
      ? {
          id: note.author_id,
          fullName: note.author_name,
          role: note.author_role,
          roleLabel: note.author_role ? ROLE_LABELS[note.author_role] : null
        }
      : null,
    department: note.department,
    departmentLabel: isDepartment(note.department ?? "")
      ? DEPARTMENT_LABELS[note.department as keyof typeof DEPARTMENT_LABELS]
      : null,
    visibility: note.visibility,
    body: note.body,
    createdAt: iso(note.created_at)
  };
}

function serializeEvent(event: OrderEventRow, viewer: SessionUser): Record<string, unknown> {
  const showMetadata = FINANCE_ROLES.has(viewer.role) || viewer.role === "WAREHOUSE";
  return {
    id: String(event.id),
    action: event.action,
    actionLabel:
      (ACTION_LABELS as Record<string, string>)[event.action] ??
      ACTION_FALLBACK_LABELS[event.action] ??
      event.action,
    fromStatus: event.from_status,
    fromStatusLabel: event.from_status
      ? (STATUS_LABELS as Record<string, string>)[event.from_status] ?? event.from_status
      : null,
    toStatus: event.to_status,
    toStatusLabel: (STATUS_LABELS as Record<string, string>)[event.to_status] ?? event.to_status,
    actor: event.actor_name
      ? {
          id: event.actor_id,
          fullName: event.actor_name,
          role: event.actor_role,
          roleLabel: event.actor_role ? ROLE_LABELS[event.actor_role] : null
        }
      : null,
    note: event.note,
    metadata: showMetadata ? safeJsonParse<unknown>(event.metadata, null) : undefined,
    createdAt: iso(event.created_at)
  };
}

function serializePayment(payment: PaymentRow): Record<string, unknown> {
  return {
    id: String(payment.id),
    amount: payment.amount,
    method: payment.method,
    reference: payment.reference,
    note: payment.note,
    paidAt: iso(payment.paid_at),
    recordedBy: payment.recorded_by_name
      ? { id: String(payment.recorded_by), fullName: payment.recorded_by_name }
      : { id: String(payment.recorded_by) }
  };
}

function serializeDelivery(delivery: DeliveryRow): Record<string, unknown> {
  return {
    id: String(delivery.id),
    shipper: delivery.shipper_name
      ? { id: delivery.shipper_id, fullName: delivery.shipper_name }
      : null,
    assignedBy: delivery.assigned_by_id,
    status: delivery.status,
    attemptCount: Number(delivery.attempt_count),
    assignedAt: iso(delivery.assigned_at),
    deliveredAt: iso(delivery.delivered_at),
    receiverName: delivery.receiver_name,
    proofNote: delivery.proof_note,
    failureReason: delivery.failure_reason
  };
}

export function serializeCustomer(row: {
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
}): Record<string, unknown> {
  return {
    id: String(row.id),
    code: row.code,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    note: row.note,
    isActive: Boolean(row.is_active),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export function serializeUser(row: {
  id: string;
  username: string;
  email: string;
  full_name: string;
  role: string;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}): Record<string, unknown> {
  return {
    id: String(row.id),
    username: row.username,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    roleLabel: (ROLE_LABELS as Record<string, string>)[row.role] ?? row.role,
    isActive: Boolean(row.is_active),
    lastLoginAt: iso(row.last_login_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export { NOTE_AUTHOR_FINANCE };
