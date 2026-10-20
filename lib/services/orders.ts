import type { z } from "zod";
import type { NextRequest } from "next/server";
import {
  getDb,
  isDuplicateKeyError,
  withTransaction,
  type DbExecutor,
  type RunResult
} from "@/lib/db";
import type { SessionUser } from "@/lib/auth/session";
import {
  type OrderStatus,
  evaluateTransition,
  stageForStatus,
  STATUS_LABELS
} from "@/lib/domain/order-state";
import { DEPARTMENT_LABELS, type Department, type Role } from "@/lib/domain/roles";
import {
  calculateOrderTotals,
  centsToMoney,
  moneyToCents,
  moneyIsZero
} from "@/lib/domain/money";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  AppError
} from "@/lib/errors";
import type { createOrderSchema, updateOrderSchema, orderTransitionSchema, recordPaymentSchema } from "@/lib/schemas/orders";
import type { OrderItemRow, OrderRow } from "@/lib/services/order-types";
import { canEditOrder, canViewOrder } from "@/lib/services/order-access";
import { getOrderDetail } from "@/lib/services/order-queries";
import { consumeStock, releaseReservedStock, reserveStock, restockAfterCancel, type SerialAssignmentInput } from "@/lib/services/inventory";
import { notifyOrderWatchers, notifyRoles, notifyUsers } from "@/lib/services/notifications";
import { writeAudit } from "@/lib/services/audit";
import {
  addMonthsToDate,
  generateCustomerCode,
  generateOrderCode,
  parseDbDate,
  parsePositiveInt,
  toIsoOrNull
} from "@/lib/utils";
import { getRequestContext } from "@/lib/http/request";
import { normalizePhone } from "@/lib/validation";

type CreateOrderInput = z.infer<typeof createOrderSchema>;
type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
type TransitionInput = z.infer<typeof orderTransitionSchema>;
type PaymentInput = z.infer<typeof recordPaymentSchema>;

interface RequestMeta {
  ip: string;
  userAgent: string | null;
}

interface CustomerSnapshot {
  customerId: string;
  fullName: string;
  phone: string;
  email: string | null;
  address: string;
}

interface PreparedLine {
  productId: string | null;
  sku: string | null;
  name: string;
  quantity: number;
  unitPriceCents: bigint;
  lineTotalCents: bigint;
  serialRequired: boolean;
  notes: string | null;
}

function requestMeta(request: NextRequest): RequestMeta {
  return getRequestContext(request);
}

function fullActor(user: SessionUser): { id: string; fullName: string } {
  return { id: user.id, fullName: user.fullName };
}

async function getLockedOrder(query: DbExecutor, orderId: string): Promise<OrderRow> {
  const row = await query
    .prepare<OrderRow>("SELECT * FROM orders WHERE id = ? FOR UPDATE")
    .bind(orderId)
    .first();
  if (!row) throw new NotFoundError("Không tìm thấy đơn hàng.");
  return row;
}

interface CustomerLookupRow {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  address: string;
  is_active: number;
}

async function resolveCustomer(
  query: DbExecutor,
  input: CreateOrderInput,
  actor: SessionUser
): Promise<CustomerSnapshot> {
  if (input.customerId) {
    const row = await query
      .prepare<CustomerLookupRow>(
        "SELECT id, full_name, phone, email, address, is_active FROM customers WHERE id = ? LIMIT 1"
      )
      .bind(input.customerId)
      .first();
    if (!row) throw new NotFoundError("Không tìm thấy khách hàng.");
    if (!Number(row.is_active)) throw new ConflictError("Khách hàng đã ngừng hoạt động.");
    return {
      customerId: String(row.id),
      fullName: row.full_name,
      phone: row.phone,
      email: row.email,
      address: row.address
    };
  }

  if (!input.customer) throw new ValidationError("Thiếu thông tin khách hàng.");
  const customer = input.customer;
  const phone = normalizePhone(customer.phone);
  if (!phone) throw new ValidationError("Số điện thoại không hợp lệ.");

  let customerId: string | null = null;
  // Không dùng ON DUPLICATE KEY vì mã khách hàng và số điện thoại đều unique:
  // nếu mã code trùng hiếm gặp, câu lệnh đó có thể sửa nhầm bản ghi khác.
  for (let attempt = 0; attempt < 5 && !customerId; attempt += 1) {
    const existing = await query
      .prepare<CustomerLookupRow>(
        `SELECT id, full_name, phone, email, address, is_active
         FROM customers WHERE phone = ? LIMIT 1`
      )
      .bind(phone)
      .first();
    if (existing) {
      if (!Number(existing.is_active)) {
        throw new ConflictError(
          "Số điện thoại thuộc khách hàng đã ngừng hoạt động. Hãy kích hoạt lại hồ sơ khách hàng trước."
        );
      }
      await query
        .prepare(
          `UPDATE customers SET
             full_name = ?, email = ?, address = ?, note = COALESCE(?, note),
             updated_at = UTC_TIMESTAMP(3)
           WHERE id = ?`
        )
        .bind(
          customer.fullName,
          customer.email ?? null,
          customer.address,
          customer.note ?? null,
          existing.id
        )
        .run();
      customerId = String(existing.id);
      break;
    }

    try {
      const result = await query
        .prepare(
          `INSERT INTO customers
             (code, full_name, phone, email, address, note, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
        )
        .bind(
          generateCustomerCode(),
          customer.fullName,
          phone,
          customer.email ?? null,
          customer.address,
          customer.note ?? null,
          actor.id
        )
        .run();
      const insertedId = String(result.lastInsertId);
      if (insertedId === "0") throw new Error("Không lấy được id khách hàng.");
      customerId = insertedId;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // Có thể request khác vừa tạo cùng số điện thoại, hoặc trùng mã code.
      // Vòng lặp sẽ kiểm tra lại theo phone; nếu vẫn chưa có thì thử mã mới.
    }
  }
  if (!customerId) throw new ConflictError("Không thể tạo mã khách hàng, vui lòng thử lại.");

  const row = await query
    .prepare<CustomerLookupRow>(
      "SELECT id, full_name, phone, email, address, is_active FROM customers WHERE id = ? LIMIT 1"
    )
    .bind(customerId)
    .first();
  if (!row) throw new ConflictError("Không thể lưu khách hàng.");
  return {
    customerId: String(row.id),
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    address: row.address
  };
}

async function prepareLines(
  query: DbExecutor,
  rawItems: CreateOrderInput["items"]
): Promise<PreparedLine[]> {
  const productIds = rawItems
    .map((item) => item.productId)
    .filter((id): id is string => Boolean(id));
  const productMap = new Map<
    string,
    { id: string; sku: string; name: string; sale_price: string; serial_required: number; is_active: number }
  >();
  if (productIds.length > 0) {
    const rows = await query
      .prepare<{
        id: string;
        sku: string;
        name: string;
        sale_price: string;
        serial_required: number;
        is_active: number;
      }>(
        `SELECT id, sku, name, sale_price, serial_required, is_active
         FROM products WHERE id IN (${productIds.map(() => "?").join(",")})`
      )
      .bind(...productIds)
      .all();
    for (const row of rows) productMap.set(String(row.id), row);
  }

  const lines: PreparedLine[] = [];
  for (const item of rawItems) {
    if (item.productId) {
      const product = productMap.get(item.productId);
      if (!product) throw new ValidationError("Sản phẩm không tồn tại.", { productId: item.productId });
      if (!Number(product.is_active)) {
        throw new ConflictError("Sản phẩm đã ngừng kinh doanh.", {
          productId: item.productId,
          sku: product.sku
        });
      }
      const unitPriceCents = moneyToCents(item.unitPrice ?? product.sale_price);
      lines.push({
        productId: String(product.id),
        sku: product.sku,
        name: product.name,
        quantity: item.quantity,
        unitPriceCents,
        lineTotalCents: unitPriceCents * BigInt(item.quantity),
        serialRequired: Boolean(product.serial_required),
        notes: item.notes ?? null
      });
    } else {
      if (!item.name || !item.unitPrice) {
        throw new ValidationError("Hàng nhập tay phải có tên và đơn giá.");
      }
      const unitPriceCents = moneyToCents(item.unitPrice);
      lines.push({
        productId: null,
        sku: item.sku ?? null,
        name: item.name,
        quantity: item.quantity,
        unitPriceCents,
        lineTotalCents: unitPriceCents * BigInt(item.quantity),
        serialRequired: false,
        notes: item.notes ?? null
      });
    }
  }
  return lines;
}

function computeTotals(
  lines: PreparedLine[],
  discountInput: string | undefined,
  shippingInput: string | undefined
) {
  return calculateOrderTotals(
    lines.map((line) => ({ quantity: line.quantity, unitPriceCents: line.unitPriceCents })),
    moneyToCents(discountInput ?? "0"),
    moneyToCents(shippingInput ?? "0")
  );
}

async function insertOrder(
  query: DbExecutor,
  options: {
    customer: CustomerSnapshot;
    actor: SessionUser;
    status: OrderStatus;
    priority: "NORMAL" | "HIGH" | "URGENT";
    expectedDeliveryDate: string | null;
    warrantyMonths: number;
    totals: ReturnType<typeof computeTotals>;
  }
): Promise<{ id: string; code: string }> {
  const { customer, actor, status, priority, expectedDeliveryDate, warrantyMonths, totals } = options;
  let code = "";
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    code = generateOrderCode();
    try {
      const result = await query
        .prepare(
          `INSERT INTO orders
            (code, customer_id, status, version, priority, created_by, current_department,
             stage_entered_at, customer_name, customer_phone, customer_email, shipping_address,
             expected_delivery_date, warranty_months, subtotal_amount, discount_amount,
             shipping_fee, total_amount, paid_amount, payment_status, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?, 'SALES', UTC_TIMESTAMP(3), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.00, 'UNPAID',
                   UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
        )
        .bind(
          code,
          customer.customerId,
          status,
          priority,
          actor.id,
          customer.fullName,
          customer.phone,
          customer.email,
          customer.address,
          expectedDeliveryDate,
          warrantyMonths,
          centsToMoney(totals.subtotal),
          centsToMoney(totals.discount),
          centsToMoney(totals.shippingFee),
          centsToMoney(totals.total)
        )
        .run();
      const id = String(result.lastInsertId);
      if (id === "0") {
        const row = await query
          .prepare<{ id: string }>("SELECT id FROM orders WHERE code = ? LIMIT 1")
          .bind(code)
          .first();
        if (!row) throw new Error("Không lấy được id đơn hàng.");
        return { id: String(row.id), code };
      }
      return { id, code };
    } catch (error) {
      lastError = error;
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
  throw new ConflictError("Không thể tạo mã đơn hàng duy nhất.", {
    cause: lastError instanceof Error ? lastError.message : undefined
  });
}

async function insertLines(query: DbExecutor, orderId: string, lines: PreparedLine[]): Promise<void> {
  for (const line of lines) {
    await query
      .prepare(
        `INSERT INTO order_items
          (order_id, product_id, sku, name, quantity, unit_price, line_total,
           serial_required, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`
      )
      .bind(
        orderId,
        line.productId,
        line.sku,
        line.name,
        line.quantity,
        centsToMoney(line.unitPriceCents),
        centsToMoney(line.lineTotalCents),
        line.serialRequired ? 1 : 0,
        line.notes
      )
      .run();
  }
}

async function addOrderNoteTx(
  query: DbExecutor,
  orderId: string,
  actor: SessionUser,
  body: string,
  visibility: "ALL" | "DEPARTMENT" | "PRIVATE",
  department: string | null
): Promise<string> {
  const result = await query
    .prepare(
      `INSERT INTO order_notes (order_id, author_id, department, visibility, body, created_at)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`
    )
    .bind(orderId, actor.id, department, visibility, body)
    .run();
  return String(result.lastInsertId);
}

async function addOrderEvent(
  query: DbExecutor,
  options: {
    orderId: string;
    action: string;
    fromStatus: OrderStatus | null;
    toStatus: OrderStatus;
    actorId: string;
    note: string | null;
    metadata?: unknown;
    ip: string | null;
  }
): Promise<void> {
  await query
    .prepare(
      `INSERT INTO order_events
        (order_id, action, from_status, to_status, actor_id, note, metadata, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`
    )
    .bind(
      options.orderId,
      options.action,
      options.fromStatus,
      options.toStatus,
      options.actorId,
      options.note,
      options.metadata === undefined ? null : JSON.stringify(options.metadata),
      options.ip
    )
    .run();
}

async function getOrderItems(query: DbExecutor, orderId: string): Promise<OrderItemRow[]> {
  return query
    .prepare<OrderItemRow>("SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC")
    .bind(orderId)
    .all();
}

function auditSnapshot(row: OrderRow): Record<string, unknown> {
  return {
    status: row.status,
    version: Number(row.version),
    assignedToId: row.assigned_to_id,
    priority: row.priority,
    paidAmount: row.paid_amount,
    paymentStatus: row.payment_status,
    customerId: row.customer_id,
    totalAmount: row.total_amount
  };
}

function transitionError(decision: { reasonCode?: string; message?: string }): AppError {
  const code = decision.reasonCode ?? "TRANSITION_NOT_ALLOWED";
  const message = decision.message ?? "Không thể thực hiện thao tác này.";
  if (["INVALID_STATE", "ALREADY_CLAIMED"].includes(code)) {
    return new ConflictError(message, { reasonCode: code });
  }
  if (code === "NOT_ASSIGNED") return new ForbiddenError(message);
  return new ForbiddenError(message);
}

async function assertVersion(row: OrderRow, expectedVersion: number): Promise<void> {
  if (Number(row.version) !== expectedVersion) {
    throw new ConflictError("Đơn hàng đã được người khác cập nhật. Vui lòng tải lại.", {
      currentVersion: Number(row.version),
      currentStatus: row.status
    });
  }
}

async function applyOrderUpdate(
  query: DbExecutor,
  row: OrderRow,
  changes: {
    status: OrderStatus;
    assignedToId: string | null;
    currentDepartment: Department | null;
    resetStageEnteredAt?: boolean;
    extraSetSql?: string;
    extraParams?: Array<string | number | null>;
  }
): Promise<void> {
  const set: string[] = [
    "status = ?",
    "assigned_to_id = ?",
    "current_department = ?",
    "version = version + 1",
    "updated_at = UTC_TIMESTAMP(3)"
  ];
  const params: Array<string | number | null> = [changes.status, changes.assignedToId, changes.currentDepartment];
  if (changes.resetStageEnteredAt !== false) {
    set.push("stage_entered_at = UTC_TIMESTAMP(3)");
  }
  if (changes.extraSetSql) {
    set.push(changes.extraSetSql);
    params.push(...(changes.extraParams ?? []));
  }
  params.push(row.id, Number(row.version));
  const result = await query
    .prepare(`UPDATE orders SET ${set.join(", ")} WHERE id = ? AND version = ?`)
    .bind(...params)
    .run();
  if (result.changes !== 1) {
    throw new ConflictError("Đơn hàng vừa thay đổi. Vui lòng tải lại.");
  }
}

async function notifyNextDepartment(
  query: DbExecutor,
  orderId: string,
  code: string,
  department: Department,
  userId: string
): Promise<void> {
  const roles: Record<Department, Role[]> = {
    SALES: ["SALES"],
    WAREHOUSE: ["WAREHOUSE"],
    TECHNICAL: ["TECHNICIAN"],
    WARRANTY: ["WARRANTY"],
    DELIVERY: ["SHIPPING_MANAGER"],
    PAYMENT: ["ACCOUNTANT"]
  };
  await notifyRoles(
    query,
    [...roles[department], "ADMIN"],
    {
      type: "ORDER_STAGE",
      title: `Đơn ${code} cần xử lý tại ${DEPARTMENT_LABELS[department]}`,
      body: `Đơn hàng vừa được chuyển sang bộ phận ${DEPARTMENT_LABELS[department]}.`,
      orderId
    },
    userId
  );
}

/** Tạo đơn. Mặc định gửi ngay sang hàng đợi kinh doanh. */
export async function createOrder(
  request: NextRequest,
  user: SessionUser,
  input: CreateOrderInput
): Promise<Record<string, unknown>> {
  if (user.role !== "SALES" && user.role !== "ADMIN") {
    throw new ForbiddenError("Chỉ kinh doanh hoặc admin được tạo đơn.");
  }
  const meta = requestMeta(request);
  const result = await withTransaction(async (query) => {
    const customer = await resolveCustomer(query, input, user);
    const lines = await prepareLines(query, input.items);
    const totals = computeTotals(lines, input.discountAmount, input.shippingFee);
    const status: OrderStatus = input.submit ? "SALES_PENDING" : "DRAFT";
    const order = await insertOrder(query, {
      customer,
      actor: user,
      status,
      priority: input.priority,
      expectedDeliveryDate: input.expectedDeliveryDate ?? null,
      warrantyMonths: input.warrantyMonths,
      totals
    });
    await insertLines(query, order.id, lines);

    await addOrderEvent(query, {
      orderId: order.id,
      action: "CREATE",
      fromStatus: null,
      toStatus: status,
      actorId: user.id,
      note: input.note ?? null,
      metadata: {
        itemCount: lines.length,
        total: centsToMoney(totals.total),
        submitted: input.submit
      },
      ip: meta.ip
    });
    if (input.note) {
      await addOrderNoteTx(query, order.id, user, input.note, "DEPARTMENT", "SALES");
    }
    if (input.submit) {
      await addOrderEvent(query, {
        orderId: order.id,
        action: "SUBMIT",
        fromStatus: "DRAFT",
        toStatus: "SALES_PENDING",
        actorId: user.id,
        note: "Gửi đơn ngay khi tạo",
        metadata: null,
        ip: meta.ip
      });
      await notifyRoles(
        query,
        ["SALES", "ADMIN"],
        {
          type: "ORDER_NEW",
          title: `Đơn mới ${order.code}`,
          body: "Đơn mới đang chờ kinh doanh xác nhận và chốt.",
          orderId: order.id
        },
        user.id
      );
    }
    await writeAudit(query, fullActor(user), {
      action: "ORDER_CREATED",
      entityType: "ORDER",
      entityId: order.id,
      orderId: order.id,
      after: {
        code: order.code,
        status,
        total: centsToMoney(totals.total),
        itemCount: lines.length
      },
      ip: meta.ip,
      userAgent: meta.userAgent
    });
    return order;
  });
  return getOrderDetail(result.id, user);
}

/** Sửa đơn còn ở giai đoạn kinh doanh, có optimistic locking bằng version. */
export async function updateOrder(
  request: NextRequest,
  user: SessionUser,
  orderId: string,
  input: UpdateOrderInput
): Promise<Record<string, unknown>> {
  if (!["SALES", "ADMIN"].includes(user.role)) {
    throw new ForbiddenError("Chỉ kinh doanh hoặc admin được sửa đơn.");
  }
  const meta = requestMeta(request);
  await withTransaction(async (query) => {
    const row = await getLockedOrder(query, orderId);
    if (!canEditOrder(user, row)) {
      throw new ConflictError("Đơn đã rời bộ phận kinh doanh hoặc bạn không phải người đang xử lý.");
    }
    await assertVersion(row, input.expectedVersion);
    const before = auditSnapshot(row);

    let customer: CustomerSnapshot = {
      customerId: String(row.customer_id),
      fullName: row.customer_name,
      phone: row.customer_phone,
      email: row.customer_email,
      address: row.shipping_address
    };
    if (input.customerId || input.customer) {
      customer = await resolveCustomer(
        query,
        {
          customerId: input.customerId,
          customer: input.customer,
          items: [],
          discountAmount: "0",
          shippingFee: "0",
          priority: input.priority ?? row.priority,
          warrantyMonths: input.warrantyMonths ?? Number(row.warranty_months),
          submit: false
        } as CreateOrderInput,
        user
      );
    }

    const existingItems = await getOrderItems(query, orderId);
    let lines: PreparedLine[];
    if (input.items) {
      lines = await prepareLines(query, input.items);
      await query.prepare("DELETE FROM order_items WHERE order_id = ?").bind(orderId).run();
      await insertLines(query, orderId, lines);
    } else {
      lines = existingItems.map((item) => ({
        productId: item.product_id ? String(item.product_id) : null,
        sku: item.sku,
        name: item.name,
        quantity: Number(item.quantity),
        unitPriceCents: moneyToCents(item.unit_price),
        lineTotalCents: moneyToCents(item.line_total),
        serialRequired: Boolean(item.serial_required),
        notes: item.notes
      }));
    }

    const totals = computeTotals(
      lines,
      input.discountAmount ?? row.discount_amount,
      input.shippingFee ?? row.shipping_fee
    );
    const expectedDelivery =
      "expectedDeliveryDate" in input ? (input.expectedDeliveryDate ?? null) : row.expected_delivery_date;
    const priority = input.priority ?? row.priority;
    const warrantyMonths = input.warrantyMonths ?? Number(row.warranty_months);

    const updateResult = await query
      .prepare(
        `UPDATE orders SET
           customer_id = ?, customer_name = ?, customer_phone = ?, customer_email = ?, shipping_address = ?,
           subtotal_amount = ?, discount_amount = ?, shipping_fee = ?, total_amount = ?,
           priority = ?, expected_delivery_date = ?, warranty_months = ?,
           version = version + 1, updated_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND version = ?`
      )
      .bind(
        customer.customerId,
        customer.fullName,
        customer.phone,
        customer.email,
        customer.address,
        centsToMoney(totals.subtotal),
        centsToMoney(totals.discount),
        centsToMoney(totals.shippingFee),
        centsToMoney(totals.total),
        priority,
        expectedDelivery,
        warrantyMonths,
        orderId,
        Number(row.version)
      )
      .run();
    if (updateResult.changes !== 1) throw new ConflictError("Đơn vừa thay đổi, vui lòng tải lại.");

    if (input.note) {
      await addOrderNoteTx(query, orderId, user, input.note, "DEPARTMENT", "SALES");
    }
    await addOrderEvent(query, {
      orderId,
      action: "UPDATE",
      fromStatus: row.status,
      toStatus: row.status,
      actorId: user.id,
      note: input.note ?? null,
      metadata: {
        changedFields: Object.keys(input).filter((key) => key !== "expectedVersion"),
        total: centsToMoney(totals.total)
      },
      ip: meta.ip
    });
    const afterRow = {
      ...row,
      version: Number(row.version) + 1,
      subtotal_amount: centsToMoney(totals.subtotal),
      discount_amount: centsToMoney(totals.discount),
      shipping_fee: centsToMoney(totals.shippingFee),
      total_amount: centsToMoney(totals.total),
      priority,
      expected_delivery_date: expectedDelivery,
      warranty_months: warrantyMonths,
      customer_id: customer.customerId,
      customer_name: customer.fullName,
      customer_phone: customer.phone,
      customer_email: customer.email,
      shipping_address: customer.address
    };
    await writeAudit(query, fullActor(user), {
      action: "ORDER_UPDATED",
      entityType: "ORDER",
      entityId: orderId,
      orderId,
      before,
      after: auditSnapshot(afterRow as OrderRow),
      ip: meta.ip,
      userAgent: meta.userAgent
    });
  });
  return getOrderDetail(orderId, user);
}

export async function transitionOrder(
  request: NextRequest,
  user: SessionUser,
  orderId: string,
  input: TransitionInput
): Promise<Record<string, unknown>> {
  const meta = requestMeta(request);
  await withTransaction(async (query) => {
    const row = await getLockedOrder(query, orderId);
    await assertVersion(row, input.expectedVersion);

    const decision = evaluateTransition({
      action: input.action,
      fromStatus: row.status,
      actor: { id: user.id, role: user.role },
      assignedToId: row.assigned_to_id ? String(row.assigned_to_id) : null,
      createdById: String(row.created_by)
    });
    if (!decision.allowed || !decision.toStatus) throw transitionError(decision);

    const toStatus = decision.toStatus;
    const targetStage = stageForStatus(toStatus);
    let assignedTo: string | null = row.assigned_to_id ? String(row.assigned_to_id) : null;
    let currentDepartment: Department | null = targetStage;
    let extraSetSql: string | undefined;
    let extraParams: Array<string | number | null> = [];
    let eventNote: string | null = input.note ?? null;
    let eventMetadata: Record<string, unknown> | null = null;
    let resetStageEnteredAt = true;
    let items: OrderItemRow[] | null = null;

    if (["COMPLETE_SALES", "COMPLETE_WAREHOUSE", "CANCEL"].includes(input.action)) {
      items = await getOrderItems(query, orderId);
    }

    switch (input.action) {
      case "SUBMIT": {
        currentDepartment = "SALES";
        assignedTo = null;
        eventNote = input.note ?? "Gửi đơn sang bộ phận kinh doanh";
        await notifyRoles(
          query,
          ["SALES", "ADMIN"],
          {
            type: "ORDER_STAGE",
            title: `Đơn ${row.code} đã được gửi`,
            body: "Đơn nháp đã được gửi vào hàng đợi kinh doanh.",
            orderId
          },
          user.id
        );
        break;
      }
      case "CLAIM": {
        assignedTo = user.id;
        currentDepartment = stageForStatus(row.status);
        resetStageEnteredAt = false;
        eventNote = input.note ?? "Nhận xử lý đơn";
        break;
      }
      case "RELEASE": {
        assignedTo = null;
        currentDepartment = stageForStatus(row.status);
        resetStageEnteredAt = false;
        eventNote = input.note ?? "Trả đơn về hàng đợi";
        break;
      }
      case "COMPLETE_SALES": {
        await reserveStock(query, row, items ?? [], user, meta.ip);
        assignedTo = null;
        currentDepartment = "WAREHOUSE";
        eventNote = input.note ?? null;
        break;
      }
      case "COMPLETE_WAREHOUSE": {
        const serials = input.serials as SerialAssignmentInput[] | undefined;
        const consumed = await consumeStock(query, row, items ?? [], serials, user);
        assignedTo = null;
        currentDepartment = "TECHNICAL";
        eventNote = input.note ?? null;
        eventMetadata = { serialsByItem: consumed.serialsByItem };
        break;
      }
      case "COMPLETE_TECHNICAL": {
        assignedTo = null;
        currentDepartment = "WARRANTY";
        eventNote = input.note ?? null;
        break;
      }
      case "COMPLETE_WARRANTY": {
        assignedTo = null;
        currentDepartment = "DELIVERY";
        eventNote = input.note ?? null;
        break;
      }
      case "ASSIGN_SHIPPER":
      case "REASSIGN_SHIPPER": {
        if (!input.shipperId) throw new ValidationError("Phải chọn shipper.");
        const shipperId = parsePositiveInt(input.shipperId)?.toString();
        if (!shipperId) throw new ValidationError("Shipper không hợp lệ.");
        const shipper = await query
          .prepare<{ id: string; full_name: string; role: string; is_active: number }>(
            "SELECT id, full_name, role, is_active FROM users WHERE id = ? LIMIT 1"
          )
          .bind(shipperId)
          .first();
        if (!shipper || shipper.role !== "SHIPPER" || !Number(shipper.is_active)) {
          throw new ValidationError("Người được chọn không phải shipper đang hoạt động.");
        }
        assignedTo = String(shipper.id);
        currentDepartment = "DELIVERY";
        resetStageEnteredAt = false;
        const delivery = await query
          .prepare<{ id: string; status: string }>(
            "SELECT id, status FROM deliveries WHERE order_id = ? FOR UPDATE"
          )
          .bind(orderId)
          .first();
        if (!delivery) {
          await query
            .prepare(
              `INSERT INTO deliveries
                (order_id, shipper_id, assigned_by_id, status, attempt_count,
                 assigned_at, created_at, updated_at)
               VALUES (?, ?, ?, 'ASSIGNED', 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
            )
            .bind(orderId, shipper.id, user.id)
            .run();
        } else {
          const nextAttempt =
            input.action === "ASSIGN_SHIPPER" && delivery.status === "FAILED"
              ? "attempt_count = attempt_count + 1,"
              : "";
          const deliveryResult = await query
            .prepare(
              `UPDATE deliveries SET
                 shipper_id = ?, assigned_by_id = ?, status = 'ASSIGNED',
                 ${nextAttempt}
                 assigned_at = UTC_TIMESTAMP(3), delivered_at = NULL,
                 receiver_name = NULL, proof_note = NULL, failure_reason = NULL,
                 updated_at = UTC_TIMESTAMP(3)
               WHERE id = ?`
            )
            .bind(shipper.id, user.id, delivery.id)
            .run();
          if (deliveryResult.changes !== 1) {
            throw new ConflictError("Thông tin giao hàng vừa thay đổi. Vui lòng tải lại.");
          }
        }
        extraSetSql = "shipped_at = COALESCE(shipped_at, UTC_TIMESTAMP(3))";
        eventNote =
          input.note ??
          `${input.action === "ASSIGN_SHIPPER" ? "Phân công" : "Đổi"} shipper ${shipper.full_name}`;
        eventMetadata = { shipperId: String(shipper.id), shipperName: shipper.full_name };
        await notifyUsers(
          query,
          [shipper.id],
          {
            type: "DELIVERY_ASSIGNED",
            title: `Bạn được giao đơn ${row.code}`,
            body: "Vui lòng kiểm tra đơn và thực hiện giao hàng.",
            orderId
          },
          user.id
        );
        break;
      }
      case "DELIVERY_FAILED": {
        assignedTo = null;
        currentDepartment = "DELIVERY";
        eventNote = input.note ?? input.failureReason ?? null;
        eventMetadata = { failureReason: input.failureReason ?? null };
        const failedResult = await query
          .prepare(
            `UPDATE deliveries SET status = 'FAILED', failure_reason = ?,
               updated_at = UTC_TIMESTAMP(3)
             WHERE order_id = ? AND status = 'ASSIGNED'`
          )
          .bind(input.failureReason ?? null, orderId)
          .run();
        if (failedResult.changes !== 1) {
          throw new ConflictError("Không tìm thấy chuyến giao đang hoạt động để báo thất bại.");
        }
        await notifyRoles(
          query,
          ["SHIPPING_MANAGER", "ADMIN"],
          {
            type: "DELIVERY_FAILED",
            title: `Giao hàng thất bại - ${row.code}`,
            body: input.failureReason ?? "Shipper báo giao hàng thất bại.",
            orderId
          },
          user.id
        );
        break;
      }
      case "COMPLETE_DELIVERY": {
        assignedTo = null;
        currentDepartment = "PAYMENT";
        extraSetSql = "delivered_at = UTC_TIMESTAMP(3)";
        eventNote = input.note ?? input.proofNote ?? `Đã giao cho ${input.receiverName ?? "khách"}`;
        eventMetadata = { receiverName: input.receiverName ?? null };
        const deliveredResult = await query
          .prepare(
            `UPDATE deliveries SET status = 'DELIVERED', delivered_at = UTC_TIMESTAMP(3),
               receiver_name = ?, proof_note = ?, failure_reason = NULL,
               updated_at = UTC_TIMESTAMP(3)
             WHERE order_id = ? AND status = 'ASSIGNED'`
          )
          .bind(input.receiverName ?? null, input.proofNote ?? null, orderId)
          .run();
        if (deliveredResult.changes !== 1) {
          throw new ConflictError("Không tìm thấy chuyến giao đang hoạt động để xác nhận.");
        }
        break;
      }
      case "COMPLETE_PAYMENT": {
        const total = moneyToCents(row.total_amount);
        const paid = moneyToCents(row.paid_amount);
        if (paid < total) {
          throw new ConflictError("Đơn chưa được thanh toán đủ, không thể hoàn tất.", {
            total: row.total_amount,
            paid: row.paid_amount,
            remaining: centsToMoney(total - paid)
          });
        }
        const deliveredAt = parseDbDate(row.delivered_at) ?? new Date();
        const warrantyMonths = Number(row.warranty_months);
        const warrantyUntil =
          warrantyMonths > 0 ? addMonthsToDate(deliveredAt, warrantyMonths) : null;
        extraSetSql = "completed_at = UTC_TIMESTAMP(3), warranty_until = ?";
        extraParams = [warrantyUntil];
        assignedTo = null;
        currentDepartment = null;
        eventNote = input.note ?? "Xác nhận hoàn tất thanh toán";
        break;
      }
      case "CANCEL": {
        if (moneyToCents(row.paid_amount) > 0n) {
          throw new ConflictError(
            "Đơn đã có thanh toán, không thể hủy trực tiếp. Cần xử lý hoàn tiền theo quy trình kế toán."
          );
        }
        const reservedOnly = ["WAREHOUSE_PENDING", "WAREHOUSE_IN_PROGRESS"].includes(row.status);
        // DELIVERY_PENDING là điểm cuối còn được hủy: hàng đã xuất kho nhưng
        // chưa giao. Sau khi giao (PAYMENT_*) không còn hủy/hoàn kho tự động.
        const consumed = [
          "TECHNICAL_PENDING",
          "TECHNICAL_IN_PROGRESS",
          "WARRANTY_PENDING",
          "WARRANTY_IN_PROGRESS",
          "DELIVERY_PENDING"
        ].includes(row.status);
        let returnedSerials: string[] = [];
        if (reservedOnly) {
          await releaseReservedStock(query, row, items ?? [], user);
        } else if (consumed) {
          const restock = await restockAfterCancel(query, row, items ?? [], user);
          returnedSerials = restock.returnedSerials;
        }
        assignedTo = null;
        currentDepartment = null;
        const reason = input.cancelReason ?? input.note ?? "Không có lý do";
        extraSetSql =
          "cancellation_reason = ?, cancelled_by_id = ?, cancelled_at = UTC_TIMESTAMP(3)";
        extraParams = [reason, user.id];
        eventNote = reason;
        eventMetadata = { returnedSerials, previousStatus: row.status };
        await notifyRoles(
          query,
          ["SALES", "ADMIN"],
          {
            type: "ORDER_CANCELLED",
            title: `Đơn ${row.code} đã bị hủy`,
            body: reason,
            orderId
          },
          user.id
        );
        break;
      }
      default:
        throw new ValidationError("Hành động không được hỗ trợ.");
    }

    if (input.action === "ASSIGN_SHIPPER" || input.action === "REASSIGN_SHIPPER") {
      // Không có gì thêm; nhánh trên đã chuẩn bị dữ liệu.
    }

    await applyOrderUpdate(query, row, {
      status: toStatus,
      assignedToId: assignedTo,
      currentDepartment,
      resetStageEnteredAt,
      extraSetSql,
      extraParams
    });

    // Thông báo bộ phận kế tiếp sau khi đã cập nhật trạng thái.
    const nextQueue: Partial<Record<OrderStatus, Department>> = {
      WAREHOUSE_PENDING: "WAREHOUSE",
      TECHNICAL_PENDING: "TECHNICAL",
      WARRANTY_PENDING: "WARRANTY",
      DELIVERY_PENDING: "DELIVERY",
      PAYMENT_PENDING: "PAYMENT"
    };
    const nextDepartment = nextQueue[toStatus];
    if (nextDepartment) {
      await notifyNextDepartment(query, orderId, row.code, nextDepartment, user.id);
      await notifyOrderWatchers(
        query,
        orderId,
        row.created_by,
        {
          type: "ORDER_STAGE",
          title: `Đơn ${row.code}: ${STATUS_LABELS[toStatus]}`,
          body: `Đơn đã được chuyển sang bộ phận ${DEPARTMENT_LABELS[nextDepartment]}.`,
          orderId
        },
        user.id
      );
    }
    if (input.action === "COMPLETE_PAYMENT") {
      await notifyOrderWatchers(
        query,
        orderId,
        row.created_by,
        {
          type: "ORDER_COMPLETED",
          title: `Đơn ${row.code} đã hoàn tất`,
          body: "Đơn hàng đã hoàn tất thanh toán và kết thúc quy trình.",
          orderId
        },
        user.id
      );
    }

    await addOrderEvent(query, {
      orderId,
      action: input.action,
      fromStatus: row.status,
      toStatus,
      actorId: user.id,
      note: eventNote,
      metadata: {
        ...(eventMetadata ?? {}),
        expectedVersion: input.expectedVersion,
        newVersion: Number(row.version) + 1
      },
      ip: meta.ip
    });
    const afterRow = {
      ...row,
      status: toStatus,
      version: Number(row.version) + 1,
      assigned_to_id: assignedTo,
      current_department: currentDepartment
    };
    await writeAudit(query, fullActor(user), {
      action: `ORDER_${input.action}`,
      entityType: "ORDER",
      entityId: orderId,
      orderId,
      before: auditSnapshot(row),
      after: auditSnapshot(afterRow as OrderRow),
      metadata: eventMetadata,
      ip: meta.ip,
      userAgent: meta.userAgent
    });
  });
  return getOrderDetail(orderId, user, { bypassAccessCheck: true });
}

export async function recordPayment(
  request: NextRequest,
  user: SessionUser,
  orderId: string,
  input: PaymentInput
): Promise<{ order: Record<string, unknown>; duplicate: boolean }> {
  if (!["ACCOUNTANT", "ADMIN"].includes(user.role)) {
    throw new ForbiddenError("Chỉ kế toán hoặc admin được ghi nhận thanh toán.");
  }
  const meta = requestMeta(request);
  const duplicate = await withTransaction(async (query) => {
    if (input.idempotencyKey) {
      const existing = await query
        .prepare<{ id: string; order_id: string }>(
          "SELECT id, order_id FROM payments WHERE idempotency_key = ? LIMIT 1"
        )
        .bind(input.idempotencyKey)
        .first();
      if (existing) {
        if (String(existing.order_id) !== orderId) {
          throw new ConflictError("Idempotency-Key đã được dùng cho đơn khác.");
        }
        return true;
      }
    }

    const row = await getLockedOrder(query, orderId);
    await assertVersion(row, input.expectedVersion);
    if (!["PAYMENT_PENDING", "PAYMENT_IN_PROGRESS"].includes(row.status)) {
      throw new ConflictError("Đơn không ở bước thanh toán.");
    }
    if (user.role !== "ADMIN" && String(row.assigned_to_id ?? "") !== user.id) {
      throw new ForbiddenError("Bạn phải nhận xử lý đơn trước khi ghi nhận thanh toán.");
    }
    const total = moneyToCents(row.total_amount);
    const paid = moneyToCents(row.paid_amount);
    if (moneyIsZero(row.total_amount)) {
      throw new ConflictError("Đơn có tổng tiền 0, không cần ghi nhận thanh toán.");
    }
    const amount = moneyToCents(input.amount);
    if (amount <= 0n) throw new ValidationError("Số tiền thanh toán phải lớn hơn 0.");
    if (amount > total - paid) {
      throw new ConflictError("Số tiền vượt quá số còn phải thu.", {
        total: row.total_amount,
        paid: row.paid_amount,
        remaining: centsToMoney(total - paid)
      });
    }

    let paymentResult: RunResult;
    try {
      paymentResult = await query
        .prepare(
          `INSERT INTO payments
            (order_id, amount, method, reference, idempotency_key, note, recorded_by,
             paid_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
        )
        .bind(
          orderId,
          centsToMoney(amount),
          input.method,
          input.reference ?? null,
          input.idempotencyKey ?? null,
          input.note ?? null,
          user.id
        )
        .run();
    } catch (error) {
      if (input.idempotencyKey && isDuplicateKeyError(error)) {
        // Hai request đồng thời cùng key: request còn lại đã ghi thành công.
        const existing = await query
          .prepare<{ order_id: string }>(
            "SELECT order_id FROM payments WHERE idempotency_key = ? LIMIT 1"
          )
          .bind(input.idempotencyKey)
          .first();
        if (existing && String(existing.order_id) === orderId) return true;
        throw new ConflictError("Idempotency-Key đã được dùng cho đơn khác.");
      }
      throw error;
    }
    const newPaid = paid + amount;
    const paymentStatus = newPaid === total ? "PAID" : "PARTIAL";
    const updateResult = await query
      .prepare(
        `UPDATE orders SET paid_amount = ?, payment_status = ?,
           payment_method = COALESCE(payment_method, ?),
           version = version + 1, updated_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND version = ?`
      )
      .bind(
        centsToMoney(newPaid),
        paymentStatus,
        input.method,
        orderId,
        Number(row.version)
      )
      .run();
    if (updateResult.changes !== 1) throw new ConflictError("Đơn vừa thay đổi, vui lòng tải lại.");

    await addOrderEvent(query, {
      orderId,
      action: "PAYMENT_RECORDED",
      fromStatus: row.status,
      toStatus: row.status,
      actorId: user.id,
      note: input.note ?? `Ghi nhận thanh toán ${centsToMoney(amount)}`,
      metadata: {
        paymentId: String(paymentResult.lastInsertId),
        amount: centsToMoney(amount),
        method: input.method,
        paidTotal: centsToMoney(newPaid)
      },
      ip: meta.ip
    });
    await writeAudit(query, fullActor(user), {
      action: "PAYMENT_RECORDED",
      entityType: "PAYMENT",
      entityId: String(paymentResult.lastInsertId),
      orderId,
      before: { paid: row.paid_amount, paymentStatus: row.payment_status },
      after: { paid: centsToMoney(newPaid), paymentStatus },
      metadata: { amount: centsToMoney(amount), method: input.method },
      ip: meta.ip,
      userAgent: meta.userAgent
    });
    return false;
  });

  const order = await getOrderDetail(orderId, user);
  return { order, duplicate };
}

export async function addOrderNote(
  user: SessionUser,
  orderId: string,
  input: { body: string; visibility: "ALL" | "DEPARTMENT" | "PRIVATE" },
  request: NextRequest
): Promise<Record<string, unknown>> {
  const meta = requestMeta(request);
  const note = await withTransaction(async (query) => {
    const row = await query
      .prepare<OrderRow>("SELECT * FROM orders WHERE id = ? FOR UPDATE")
      .bind(orderId)
      .first();
    if (!row) throw new NotFoundError("Không tìm thấy đơn hàng.");
    if (!canViewOrder(user, row)) throw new NotFoundError("Không tìm thấy đơn hàng.");
    if (input.visibility === "ALL" && !["ADMIN", "SALES"].includes(user.role)) {
      throw new ForbiddenError("Chỉ kinh doanh hoặc admin được tạo ghi chú cho mọi bộ phận.");
    }
    const roleDepartment = user.role === "ADMIN" ? null : departmentForRoleSafe(user.role);
    const department =
      input.visibility === "DEPARTMENT"
        ? user.role === "ADMIN"
          ? row.current_department
          : roleDepartment
        : null;
    if (input.visibility === "DEPARTMENT" && !department) {
      throw new ValidationError("Không xác định được bộ phận cho ghi chú.");
    }
    const id = await addOrderNoteTx(
      query,
      orderId,
      user,
      input.body,
      input.visibility,
      department
    );
    await addOrderEvent(query, {
      orderId,
      action: "NOTE_ADDED",
      fromStatus: row.status,
      toStatus: row.status,
      actorId: user.id,
      note: null,
      metadata: { noteId: id, visibility: input.visibility, department },
      ip: meta.ip
    });
    await writeAudit(query, fullActor(user), {
      action: "ORDER_NOTE_ADDED",
      entityType: "ORDER_NOTE",
      entityId: id,
      orderId,
      after: { visibility: input.visibility, department },
      ip: meta.ip,
      userAgent: meta.userAgent
    });
    return {
      id,
      visibility: input.visibility,
      department,
      body: input.body,
      createdAt: new Date().toISOString(),
      author: { id: user.id, fullName: user.fullName, role: user.role }
    };
  });
  return note;
}

function departmentForRoleSafe(role: Role): string | null {
  if (role === "ADMIN") return null;
  const mapping: Partial<Record<Role, string>> = {
    SALES: "SALES",
    WAREHOUSE: "WAREHOUSE",
    TECHNICIAN: "TECHNICAL",
    WARRANTY: "WARRANTY",
    SHIPPING_MANAGER: "DELIVERY",
    SHIPPER: "DELIVERY",
    ACCOUNTANT: "PAYMENT"
  };
  return mapping[role] ?? null;
}

/** API công khai: chỉ trả trạng thái tối thiểu, xác thực bằng 4 số cuối SĐT. */
export async function trackOrderPublic(
  code: string,
  phoneInput: string
): Promise<Record<string, unknown>> {
  const normalizedCode = code.trim().toUpperCase();
  if (!/^PCM-\d{6}-[A-Z0-9]{8}$/.test(normalizedCode)) {
    throw new NotFoundError("Không tìm thấy đơn hàng.");
  }
  const row = await getDb()
    .prepare<{
      code: string;
      status: OrderStatus;
      current_department: string | null;
      shipped_at: string | null;
      delivered_at: string | null;
      completed_at: string | null;
      updated_at: string;
      customer_phone: string;
      expected_delivery_date: string | null;
    }>(
      `SELECT code, status, current_department, shipped_at, delivered_at, completed_at,
              updated_at, customer_phone, expected_delivery_date
       FROM orders WHERE code = ? LIMIT 1`
    )
    .bind(normalizedCode)
    .first();
  if (!row || row.status === "DRAFT") {
    throw new NotFoundError("Không tìm thấy đơn hàng.");
  }
  const orderPhone = normalizePhone(row.customer_phone).replace(/^\+84/, "0");
  const inputPhone = normalizePhone(phoneInput).replace(/^\+84/, "0");
  const phoneMatches =
    inputPhone.replace(/\D/g, "").length === 4
      ? orderPhone.endsWith(inputPhone.replace(/\D/g, ""))
      : orderPhone === inputPhone;
  if (!phoneMatches) {
    // Không tiết lộ mã đơn có tồn tại hay không.
    throw new NotFoundError("Không tìm thấy đơn hàng.");
  }
  const department =
    row.current_department && Object.prototype.hasOwnProperty.call(DEPARTMENT_LABELS, row.current_department)
      ? (row.current_department as Department)
      : stageForStatus(row.status);
  return {
    code: row.code,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] ?? row.status,
    departmentLabel: department ? DEPARTMENT_LABELS[department] : null,
    updatedAt: toIsoOrNull(row.updated_at),
    expectedDeliveryDate: row.expected_delivery_date,
    shippedAt: toIsoOrNull(row.shipped_at),
    deliveredAt: toIsoOrNull(row.delivered_at),
    completedAt: toIsoOrNull(row.completed_at)
  };
}

