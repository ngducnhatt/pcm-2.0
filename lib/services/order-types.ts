import type { Role } from "@/lib/domain/roles";
import type { OrderStatus } from "@/lib/domain/order-state";

export interface OrderRow {
  id: string;
  code: string;
  customer_id: string;
  status: OrderStatus;
  version: number | string;
  priority: "NORMAL" | "HIGH" | "URGENT";
  assigned_to_id: string | null;
  assigned_to_name: string | null;
  assigned_to_role: Role | null;
  created_by: string;
  created_by_name: string | null;
  current_department: string | null;
  stage_entered_at: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  shipping_address: string;
  expected_delivery_date: string | null;
  warranty_months: number;
  subtotal_amount: string;
  discount_amount: string;
  shipping_fee: string;
  total_amount: string;
  paid_amount: string;
  payment_status: string;
  payment_method: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
  warranty_until: string | null;
  cancellation_reason: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  item_count?: number | string;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string | null;
  sku: string | null;
  name: string;
  quantity: number;
  unit_price: string;
  line_total: string;
  serial_required: number;
  notes: string | null;
}

export interface OrderSerialRow {
  order_item_id: string;
  stock_serial_id: string;
  serial_number: string;
}

export interface OrderNoteRow {
  id: string;
  author_id: string | null;
  author_name: string | null;
  author_role: Role | null;
  department: string | null;
  visibility: "ALL" | "DEPARTMENT" | "PRIVATE";
  body: string;
  created_at: string;
}

export interface OrderEventRow {
  id: string;
  action: string;
  from_status: string | null;
  to_status: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: Role | null;
  note: string | null;
  metadata: unknown;
  ip: string | null;
  created_at: string;
}

export interface PaymentRow {
  id: string;
  amount: string;
  method: string;
  reference: string | null;
  note: string | null;
  paid_at: string;
  recorded_by: string;
  recorded_by_name: string | null;
}

export interface DeliveryRow {
  id: string;
  shipper_id: string | null;
  shipper_name: string | null;
  assigned_by_id: string | null;
  status: string;
  attempt_count: number;
  assigned_at: string;
  delivered_at: string | null;
  receiver_name: string | null;
  proof_note: string | null;
  failure_reason: string | null;
}

export interface OrderDetailExtras {
  items?: OrderItemRow[];
  serials?: OrderSerialRow[];
  notes?: OrderNoteRow[];
  events?: OrderEventRow[];
  payments?: PaymentRow[];
  delivery?: DeliveryRow | null;
}

export interface Viewer {
  id: string;
  role: Role;
  fullName: string;
}
