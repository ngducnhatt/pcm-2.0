import test from "node:test";
import assert from "node:assert/strict";
import {
  availableActionsFor,
  evaluateTransition,
  type OrderAction,
  type OrderStatus,
  type TransitionDecision
} from "../lib/domain/order-state";
import type { Role } from "../lib/domain/roles";
import {
  calculateOrderTotals,
  centsToMoney,
  moneyToCents,
  subtractMoney
} from "../lib/domain/money";
import {
  addMonthsToDate,
  generateOrderCode,
  safeJsonParse,
  toIsoOrNull
} from "../lib/utils";
import { splitSqlStatements } from "../scripts/migrate";
import { createOrderSchema, orderTransitionSchema } from "../lib/schemas/orders";

const IDS: Record<Role, string> = {
  ADMIN: "1",
  SALES: "10",
  WAREHOUSE: "20",
  TECHNICIAN: "30",
  WARRANTY: "40",
  SHIPPING_MANAGER: "50",
  SHIPPER: "51",
  ACCOUNTANT: "60"
};

const CREATED_BY = IDS.SALES;

function decide(
  action: OrderAction,
  fromStatus: OrderStatus,
  role: Role,
  options: { assignedToId?: string | null; actorId?: string } = {}
): TransitionDecision {
  return evaluateTransition({
    action,
    fromStatus,
    actor: { id: options.actorId ?? IDS[role], role },
    assignedToId: options.assignedToId ?? null,
    createdById: CREATED_BY
  });
}

function allowed(
  action: OrderAction,
  fromStatus: OrderStatus,
  role: Role,
  options: { assignedToId?: string | null; actorId?: string } = {}
): OrderStatus {
  const decision = decide(action, fromStatus, role, options);
  assert.equal(
    decision.allowed,
    true,
    `${action} ${fromStatus} by ${role} phải được phép: ${decision.reasonCode ?? ""} ${decision.message ?? ""}`
  );
  assert.ok(decision.toStatus);
  return decision.toStatus;
}

function denied(
  action: OrderAction,
  fromStatus: OrderStatus,
  role: Role,
  reasonCode: string,
  options: { assignedToId?: string | null; actorId?: string } = {}
): void {
  const decision = decide(action, fromStatus, role, options);
  assert.equal(decision.allowed, false, `${action} ${fromStatus} by ${role} phải bị từ chối.`);
  assert.equal(decision.reasonCode, reasonCode);
}

test("luồng đầy đủ từ nháp đến hoàn tất đúng thứ tự", () => {
  let status: OrderStatus = "DRAFT";
  let assigned: string | null = null;
  const visited: OrderStatus[] = [status];

  const step = (action: OrderAction, role: Role, nextAssigned: string | null = null) => {
    status = allowed(action, status, role, { assignedToId: assigned });
    assigned = nextAssigned;
    visited.push(status);
  };

  step("SUBMIT", "SALES");
  step("CLAIM", "SALES", IDS.SALES);
  step("COMPLETE_SALES", "SALES");
  step("CLAIM", "WAREHOUSE", IDS.WAREHOUSE);
  step("COMPLETE_WAREHOUSE", "WAREHOUSE");
  step("CLAIM", "TECHNICIAN", IDS.TECHNICIAN);
  step("COMPLETE_TECHNICAL", "TECHNICIAN");
  step("CLAIM", "WARRANTY", IDS.WARRANTY);
  step("COMPLETE_WARRANTY", "WARRANTY");
  step("ASSIGN_SHIPPER", "SHIPPING_MANAGER", IDS.SHIPPER);
  step("COMPLETE_DELIVERY", "SHIPPER", null);
  step("CLAIM", "ACCOUNTANT", IDS.ACCOUNTANT);
  step("COMPLETE_PAYMENT", "ACCOUNTANT", null);

  assert.deepEqual(visited, [
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
    "COMPLETED"
  ]);
});

test("claim sai bộ phận, hoàn tất khi chưa nhận đơn và shipper sai người đều bị chặn", () => {
  denied("CLAIM", "WAREHOUSE_PENDING", "SALES", "FORBIDDEN");
  denied("CLAIM", "SALES_PENDING", "WAREHOUSE", "FORBIDDEN");
  denied("COMPLETE_SALES", "SALES_IN_PROGRESS", "SALES", "NOT_ASSIGNED");
  denied("COMPLETE_PAYMENT", "PAYMENT_PENDING", "ACCOUNTANT", "INVALID_STATE");
  denied("COMPLETE_DELIVERY", "DELIVERY_IN_PROGRESS", "SHIPPER", "FORBIDDEN", {
    assignedToId: IDS.SHIPPER,
    actorId: "52"
  });
  denied("CLAIM", "DELIVERY_PENDING", "SHIPPING_MANAGER", "INVALID_STATE");
  denied("ASSIGN_SHIPPER", "DELIVERY_PENDING", "SHIPPER", "FORBIDDEN");
});

test("admin được hoàn tất bước mà không cần claim; shipper được báo giao thất bại đúng đơn", () => {
  assert.equal(
    allowed("COMPLETE_SALES", "SALES_IN_PROGRESS", "ADMIN", { assignedToId: null }),
    "WAREHOUSE_PENDING"
  );
  assert.equal(
    allowed("DELIVERY_FAILED", "DELIVERY_IN_PROGRESS", "SHIPPER", {
      assignedToId: IDS.SHIPPER
    }),
    "DELIVERY_PENDING"
  );
  denied("DELIVERY_FAILED", "DELIVERY_IN_PROGRESS", "SHIPPER", "FORBIDDEN", {
    assignedToId: IDS.SHIPPER,
    actorId: "52"
  });
  assert.equal(
    allowed("REASSIGN_SHIPPER", "DELIVERY_IN_PROGRESS", "SHIPPING_MANAGER", {
      assignedToId: IDS.SHIPPER
    }),
    "DELIVERY_IN_PROGRESS"
  );
});

test("hủy đơn chỉ trước khi giao; sau khi đã giao không còn hủy tự động", () => {
  denied("CANCEL", "DELIVERY_IN_PROGRESS", "ADMIN", "INVALID_STATE");
  denied("CANCEL", "PAYMENT_PENDING", "ADMIN", "INVALID_STATE");
  denied("CANCEL", "PAYMENT_IN_PROGRESS", "ADMIN", "INVALID_STATE");
  denied("CANCEL", "WARRANTY_PENDING", "WAREHOUSE", "FORBIDDEN");
  assert.equal(
    allowed("CANCEL", "SALES_PENDING", "SALES", { assignedToId: null }),
    "CANCELLED"
  );
  assert.equal(
    allowed("CANCEL", "DELIVERY_PENDING", "ADMIN", { assignedToId: null }),
    "CANCELLED"
  );
});

test("gợi ý hành động khớp với state machine", () => {
  const actions = availableActionsFor({
    fromStatus: "SALES_PENDING",
    actor: { id: IDS.SALES, role: "SALES" },
    assignedToId: null,
    createdById: CREATED_BY
  });
  assert.deepEqual(actions, ["CLAIM", "CANCEL"]);

  const shipperActions = availableActionsFor({
    fromStatus: "DELIVERY_IN_PROGRESS",
    actor: { id: IDS.SHIPPER, role: "SHIPPER" },
    assignedToId: IDS.SHIPPER,
    createdById: CREATED_BY
  });
  assert.deepEqual(shipperActions, ["DELIVERY_FAILED", "COMPLETE_DELIVERY"]);
});

test("tính tiền bằng cents, không sai số dấu phẩy động", () => {
  const totals = calculateOrderTotals(
    [
      { quantity: 2, unitPriceCents: moneyToCents("123.45") },
      { quantity: 1, unitPriceCents: moneyToCents("0.99") }
    ],
    moneyToCents("10.00"),
    moneyToCents("5.50")
  );
  assert.equal(centsToMoney(totals.subtotal), "247.89");
  assert.equal(centsToMoney(totals.discount), "10.00");
  assert.equal(centsToMoney(totals.shippingFee), "5.50");
  assert.equal(centsToMoney(totals.total), "243.39");
  assert.equal(moneyToCents("0.1"), 10n);
  assert.equal(subtractMoney("100.00", "99.99"), "0.01");
  assert.equal(subtractMoney("1.00", "2.00"), "0.00");
  assert.throws(() => moneyToCents("1.005"));
  assert.throws(() => moneyToCents("-1"));
  assert.throws(() =>
    calculateOrderTotals([{ quantity: 1, unitPriceCents: 100n }], 101n, 0n)
  );
});

test("mã đơn, ngày bảo hành và chuyển đổi thời gian UTC", () => {
  const code = generateOrderCode(new Date("2026-10-20T12:00:00Z"));
  assert.match(code, /^PCM-261020-[A-Z0-9]{8}$/);
  assert.notEqual(generateOrderCode(), generateOrderCode());

  assert.equal(addMonthsToDate(new Date("2026-01-31T00:00:00Z"), 1), "2026-02-28");
  assert.equal(addMonthsToDate(new Date("2024-01-31T00:00:00Z"), 1), "2024-02-29");
  assert.equal(addMonthsToDate(new Date("2026-01-15T00:00:00Z"), 12), "2027-01-15");

  assert.equal(toIsoOrNull("2026-10-20 10:20:30.123"), "2026-10-20T10:20:30.123Z");
  assert.equal(toIsoOrNull("2026-10-20"), "2026-10-20T00:00:00.000Z");
  assert.equal(toIsoOrNull(null), null);
  assert.deepEqual(safeJsonParse('{"a":1}', null), { a: 1 });
  assert.equal(safeJsonParse("not-json", "fallback"), "fallback");
});

test("schema chặn thiếu lý do hủy, thiếu ghi chú hoàn tất và sản phẩm trùng", () => {
  assert.equal(
    orderTransitionSchema.safeParse({
      action: "CANCEL",
      expectedVersion: 1,
      cancelReason: "Khách yêu cầu hủy"
    }).success,
    true
  );
  assert.equal(
    orderTransitionSchema.safeParse({
      action: "CANCEL",
      expectedVersion: 1
    }).success,
    false
  );
  assert.equal(
    orderTransitionSchema.safeParse({
      action: "COMPLETE_WAREHOUSE",
      expectedVersion: 1,
      note: ""
    }).success,
    false
  );
  assert.equal(
    orderTransitionSchema.safeParse({
      action: "COMPLETE_DELIVERY",
      expectedVersion: 1
    }).success,
    false
  );
  assert.equal(
    createOrderSchema.safeParse({
      customer: {
        fullName: "Nguyễn Văn A",
        phone: "0901234567",
        address: "123 Đường ABC, Quận 1"
      },
      items: [
        { productId: "1", quantity: 1 },
        { productId: "1", quantity: 2 }
      ]
    }).success,
    false
  );
  assert.equal(
    createOrderSchema.safeParse({
      customer: {
        fullName: "Nguyễn Văn A",
        phone: "0901234567",
        address: "123 Đường ABC, Quận 1"
      },
      items: [{ productId: "1", quantity: 1 }]
    }).success,
    true
  );
});

test("bộ tách SQL xử lý comment, dấu chấm phẩy trong chuỗi và backtick", () => {
  assert.deepEqual(splitSqlStatements(""), []);
  assert.deepEqual(
    splitSqlStatements("SELECT 1; SELECT ';' AS semi;"),
    ["SELECT 1", "SELECT ';' AS semi"]
  );
  assert.deepEqual(
    splitSqlStatements("-- đầu file\nSELECT 1;\n# comment\nSELECT `a;b` FROM t;"),
    ["SELECT 1", "SELECT `a;b` FROM t"]
  );
  assert.deepEqual(
    splitSqlStatements("/* ; */ SELECT 'it''s; fine'; -- x;\nSELECT 2"),
    ["SELECT 'it''s; fine'", "SELECT 2"]
  );
  assert.deepEqual(
    splitSqlStatements("SELECT 'a\\'b;c';"),
    ["SELECT 'a\\'b;c'"]
  );
});
