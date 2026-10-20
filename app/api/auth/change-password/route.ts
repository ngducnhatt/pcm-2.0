import type { NextRequest } from "next/server";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { assertTrustedOrigin, requireUser } from "@/lib/auth/guard";
import {
  checkPasswordPolicy,
  hashPassword,
  verifyPassword
} from "@/lib/auth/password";
import { revokeUserSessionsTx } from "@/lib/auth/session";
import { ValidationError } from "@/lib/errors";
import { readJsonBody } from "@/lib/http/body";
import { getRequestContext } from "@/lib/http/request";
import { handleApiError, ok } from "@/lib/http/response";
import { writeAudit } from "@/lib/services/audit";
import { passwordLoginSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z
  .object({
    currentPassword: passwordLoginSchema,
    newPassword: passwordLoginSchema
  })
  .superRefine((value, ctx) => {
    const policy = checkPasswordPolicy(value.newPassword);
    if (!policy.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["newPassword"],
        message: policy.message ?? "Mật khẩu mới không đủ mạnh."
      });
    }
    if (value.currentPassword === value.newPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["newPassword"],
        message: "Mật khẩu mới phải khác mật khẩu hiện tại."
      });
    }
  });

export async function POST(request: NextRequest): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const user = await requireUser(request);
    const input = await readJsonBody(request, schema, 8 * 1024);
    const meta = getRequestContext(request);

    const row = await withTransaction(async (query) => {
      const current = await query
        .prepare<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ? FOR UPDATE")
        .bind(user.id)
        .first();
      if (!current) throw new ValidationError("Không tìm thấy tài khoản.");
      const valid = await verifyPassword(input.currentPassword, current.password_hash);
      if (!valid) throw new ValidationError("Mật khẩu hiện tại không đúng.");
      const newHash = await hashPassword(input.newPassword);
      await query
        .prepare(
          `UPDATE users SET password_hash = ?, password_changed_at = UTC_TIMESTAMP(3),
             failed_login_attempts = 0, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
           WHERE id = ?`
        )
        .bind(newHash, user.id)
        .run();
      const revoked = await revokeUserSessionsTx(query, user.id, user.sessionTokenHash);
      await writeAudit(query, { id: user.id, fullName: user.fullName }, {
        action: "AUTH_PASSWORD_CHANGED",
        entityType: "USER",
        entityId: user.id,
        metadata: { revokedOtherSessions: revoked },
        ip: meta.ip,
        userAgent: meta.userAgent
      });
      return { revoked };
    });

    return ok({ changed: true, revokedOtherSessions: row.revoked });
  } catch (error) {
    return handleApiError(error, { request });
  }
}
