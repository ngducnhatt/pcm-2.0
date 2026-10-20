import { z } from "zod";
import { ORDER_STATUSES } from "@/lib/domain/order-state";
import { ROLES } from "@/lib/domain/roles";

export const idSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{0,19}$/, "ID không hợp lệ.");

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Tên đăng nhập tối thiểu 3 ký tự.")
  .max(50)
  .regex(/^[a-zA-Z0-9._-]+$/, "Tên đăng nhập chỉ gồm chữ, số, dấu chấm, gạch dưới, gạch ngang.")
  .transform((value) => value.toLowerCase());

export const emailSchema = z
  .string()
  .trim()
  .max(190)
  .email("Email không hợp lệ.")
  .transform((value) => value.toLowerCase());

export const phoneSchema = z
  .string()
  .trim()
  .min(8, "Số điện thoại tối thiểu 8 ký tự.")
  .max(30)
  .regex(/^[0-9+().\s-]+$/, "Số điện thoại không hợp lệ.");

export const passwordLoginSchema = z.string().min(1).max(200);

export const moneyInputSchema = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    try {
      const normalized = typeof value === "number" ? value.toString() : value.trim();
      if (!/^\d{1,15}(\.\d{1,2})?$/.test(normalized)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Số tiền không hợp lệ." });
        return z.NEVER;
      }
      return normalized;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Số tiền không hợp lệ." });
      return z.NEVER;
    }
  });

export const roleSchema = z.enum(ROLES);
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export const queueSchema = z.enum([
  "sales",
  "warehouse",
  "technical",
  "warranty",
  "delivery",
  "payment"
]);

export const prioritySchema = z.enum(["NORMAL", "HIGH", "URGENT"]);
export const paymentMethodSchema = z.enum([
  "CASH",
  "BANK_TRANSFER",
  "CARD",
  "COD",
  "OTHER"
]);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày phải có định dạng YYYY-MM-DD.")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Ngày không hợp lệ.");

export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

export function zodIssueDetails(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 30).map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message
  }));
}

export function normalizePhone(value: string): string {
  return value.replace(/[^0-9+]/g, "");
}
