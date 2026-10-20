import { z } from "zod";
import {
  dateOnlySchema,
  emailSchema,
  idSchema,
  moneyInputSchema,
  orderStatusSchema,
  paginationSchema,
  paymentMethodSchema,
  phoneSchema,
  prioritySchema
} from "@/lib/validation";
import { ORDER_ACTIONS } from "@/lib/domain/order-state";

const customerInputSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: phoneSchema,
  email: emailSchema.optional(),
  address: z.string().trim().min(5).max(500),
  note: z.string().trim().max(1000).optional()
});

const orderItemSchema = z
  .object({
    productId: idSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    sku: z.string().trim().max(64).optional(),
    quantity: z.coerce.number().int().min(1).max(1000),
    unitPrice: moneyInputSchema.optional(),
    notes: z.string().trim().max(500).optional()
  })
  .superRefine((item, ctx) => {
    if (!item.productId && !item.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["name"],
        message: "Dòng hàng phải có productId hoặc tên hàng."
      });
    }
    if (!item.productId && !item.unitPrice) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unitPrice"],
        message: "Hàng nhập tay phải có đơn giá."
      });
    }
  });

function checkUniqueProducts(
  items: Array<{ productId?: string }>,
  ctx: z.RefinementCtx
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (!item.productId) continue;
    if (seen.has(item.productId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "productId"],
        message: "Một sản phẩm chỉ được xuất hiện một lần; hãy gộp số lượng."
      });
    }
    seen.add(item.productId);
  }
}

export const createOrderSchema = z
  .object({
    customerId: idSchema.optional(),
    customer: customerInputSchema.optional(),
    items: z.array(orderItemSchema).min(1).max(100),
    discountAmount: moneyInputSchema.default("0"),
    shippingFee: moneyInputSchema.default("0"),
    priority: prioritySchema.default("NORMAL"),
    expectedDeliveryDate: dateOnlySchema.nullable().optional(),
    warrantyMonths: z.coerce.number().int().min(0).max(120).default(12),
    note: z.string().trim().max(2000).optional(),
    submit: z.boolean().default(true)
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.customerId) === Boolean(value.customer)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customerId"],
        message: "Chọn customerId hoặc customer, không thể vừa có vừa không."
      });
    }
    checkUniqueProducts(value.items, ctx);
  });

export const updateOrderSchema = z
  .object({
    expectedVersion: z.coerce.number().int().min(0),
    customerId: idSchema.optional(),
    customer: customerInputSchema.optional(),
    items: z.array(orderItemSchema).min(1).max(100).optional(),
    discountAmount: moneyInputSchema.optional(),
    shippingFee: moneyInputSchema.optional(),
    priority: prioritySchema.optional(),
    expectedDeliveryDate: dateOnlySchema.nullable().optional(),
    warrantyMonths: z.coerce.number().int().min(0).max(120).optional(),
    note: z.string().trim().max(2000).optional()
  })
  .superRefine((value, ctx) => {
    if (value.customerId && value.customer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customerId"],
        message: "Chọn customerId hoặc customer, không truyền cả hai."
      });
    }
    if (Object.keys(value).every((key) => key === "expectedVersion")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Không có dữ liệu cần cập nhật." });
    }
    if (value.items) checkUniqueProducts(value.items, ctx);
  });

const serialAssignmentSchema = z.object({
  orderItemId: idSchema,
  serialNumbers: z.array(z.string().trim().min(1).max(190)).min(1).max(1000)
});

export const orderTransitionSchema = z
  .object({
    action: z.enum(ORDER_ACTIONS),
    expectedVersion: z.coerce.number().int().min(0),
    note: z.string().trim().max(2000).optional(),
    shipperId: idSchema.optional(),
    serials: z.array(serialAssignmentSchema).max(100).optional(),
    receiverName: z.string().trim().min(2).max(120).optional(),
    proofNote: z.string().trim().max(1000).optional(),
    failureReason: z.string().trim().min(5).max(1000).optional(),
    cancelReason: z.string().trim().min(5).max(1000).optional()
  })
  .superRefine((value, ctx) => {
    if (["ASSIGN_SHIPPER", "REASSIGN_SHIPPER"].includes(value.action) && !value.shipperId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shipperId"],
        message: "Phải chọn shipper."
      });
    }
    if (value.action === "COMPLETE_DELIVERY" && !value.receiverName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receiverName"],
        message: "Phải nhập tên người nhận hàng."
      });
    }
    if (value.action === "DELIVERY_FAILED" && !value.failureReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failureReason"],
        message: "Phải nhập lý do giao thất bại."
      });
    }
    if (value.action === "CANCEL" && !value.cancelReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cancelReason"],
        message: "Phải nhập lý do hủy đơn."
      });
    }
    if (
      ["COMPLETE_SALES", "COMPLETE_WAREHOUSE", "COMPLETE_TECHNICAL", "COMPLETE_WARRANTY"].includes(
        value.action
      ) &&
      (!value.note || value.note.length < 3)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["note"],
        message: "Phải ghi chú nội dung hoàn tất bước này."
      });
    }
  });

export const orderNoteSchema = z.object({
  body: z.string().trim().min(2).max(4000),
  visibility: z.enum(["ALL", "DEPARTMENT", "PRIVATE"]).default("DEPARTMENT")
});

export const recordPaymentSchema = z.object({
  expectedVersion: z.coerce.number().int().min(0),
  amount: moneyInputSchema,
  method: paymentMethodSchema,
  reference: z.string().trim().max(190).optional(),
  note: z.string().trim().max(1000).optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional()
});

export const orderListQuerySchema = paginationSchema.extend({
  status: orderStatusSchema.optional(),
  q: z.string().trim().max(100).optional(),
  assigned: z.enum(["me", "all"]).default("all"),
  priority: prioritySchema.optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  sort: z.enum(["newest", "oldest", "priority", "updated"]).default("newest")
});

export const queueQuerySchema = paginationSchema.extend({
  includeDrafts: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(["newest", "oldest", "priority"]).default("priority")
});

export const trackingQuerySchema = z.object({
  phone: z.string().trim().min(4).max(30)
});

export const historyQuerySchema = paginationSchema;
