import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb, withTransaction } from "@/lib/db";
import { assertTrustedOrigin } from "@/lib/auth/guard";
import {
  burnPasswordTime,
  verifyPassword
} from "@/lib/auth/password";
import {
  buildSessionCookie,
  createSession
} from "@/lib/auth/session";
import { isRole, ROLE_LABELS } from "@/lib/domain/roles";
import { enforceLoginRateLimit } from "@/lib/http/rate-limit";
import { readJsonBody } from "@/lib/http/body";
import { getRequestContext } from "@/lib/http/request";
import { handleApiError, ok } from "@/lib/http/response";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/services/audit";
import { parseDbDate } from "@/lib/utils";
import { passwordLoginSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(190),
  password: passwordLoginSchema
});

interface LoginUserRow {
  id: string;
  username: string;
  email: string;
  full_name: string;
  password_hash: string;
  role: string;
  is_active: number;
  failed_login_attempts: number;
  locked_until: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(request: NextRequest): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const meta = getRequestContext(request);
    const input = await readJsonBody(request, loginSchema, 8 * 1024);
    const identifier = input.identifier.toLowerCase();

    // Rate limit theo IP và identifier trước khi truy vấn, chống dò mật khẩu.
    await enforceLoginRateLimit(meta.ip, identifier);

    const user = await getDb()
      .prepare<LoginUserRow>(
        `SELECT id, username, email, full_name, password_hash, role, is_active,
                failed_login_attempts, locked_until
         FROM users
         WHERE username = ? OR email = ?
         LIMIT 1`
      )
      .bind(identifier, identifier)
      .first();

    const locked = Boolean(user?.locked_until && (parseDbDate(user.locked_until)?.getTime() ?? 0) > Date.now());
    if (!user) {
      await burnPasswordTime(input.password);
      await safelyRecordLogin(meta, identifier, false, null);
      // Trễ nhỏ làm giảm khả năng phân biệt user tồn tại qua timing tổng thể.
      await sleep(80);
      return failLogin();
    }

    if (locked || !Number(user.is_active)) {
      await burnPasswordTime(input.password);
      await safelyRecordLogin(meta, identifier, false, user.id);
      await sleep(80);
      return failLogin(locked ? 429 : 401);
    }

    const passwordOk = await verifyPassword(input.password, user.password_hash);
    if (!passwordOk || !isRole(user.role)) {
      await recordFailedAttempt(user.id);
      await safelyRecordLogin(meta, identifier, false, user.id);
      await sleep(80);
      return failLogin();
    }

    const session = await withTransaction(async (query) => {
      await query
        .prepare(
          `UPDATE users SET failed_login_attempts = 0, locked_until = NULL,
             last_login_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
           WHERE id = ?`
        )
        .bind(user.id)
        .run();
      const createdSession = await createSession(user.id, meta.ip, meta.userAgent, query);
      await query
        .prepare(
          `INSERT INTO login_attempts (identifier, ip, success, user_id, user_agent, created_at)
           VALUES (?, ?, 1, ?, ?, UTC_TIMESTAMP(3))`
        )
        .bind(user.username, meta.ip, user.id, meta.userAgent)
        .run();
      await writeAudit(query, { id: user.id, fullName: user.full_name }, {
        action: "AUTH_LOGIN_SUCCESS",
        entityType: "USER",
        entityId: user.id,
        metadata: { username: user.username },
        ip: meta.ip,
        userAgent: meta.userAgent
      });
      return createdSession;
    });

    const response = ok({
      user: {
        id: String(user.id),
        username: user.username,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        roleLabel: ROLE_LABELS[user.role]
      },
      sessionExpiresAt: session.expiresAt.toISOString()
    });
    response.cookies.set(buildSessionCookie(session.token, session.expiresAt));
    logger.info("Đăng nhập thành công", {
      userId: user.id,
      username: user.username,
      ip: meta.ip
    });
    return response;
  } catch (error) {
    return handleApiError(error, { request });
  }
}

function failLogin(status = 401): Response {
  return Response.json(
    {
      error: {
        code: status === 429 ? "LOGIN_UNAVAILABLE" : "INVALID_CREDENTIALS",
        message:
          "Tên đăng nhập hoặc mật khẩu không đúng, hoặc tài khoản tạm thời không thể đăng nhập."
      }
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(status === 429 ? { "Retry-After": "60" } : {})
      }
    }
  );
}

async function recordFailedAttempt(userId: string): Promise<void> {
  try {
    await getDb()
      .prepare(
        `UPDATE users
         SET failed_login_attempts = failed_login_attempts + 1,
             locked_until = CASE
               WHEN failed_login_attempts + 1 >= 5
               THEN DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE)
               ELSE locked_until
             END,
             updated_at = UTC_TIMESTAMP(3)
         WHERE id = ?`
      )
      .bind(userId)
      .run();
  } catch (error) {
    logger.error("Không cập nhật được số lần đăng nhập sai", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function safelyRecordLogin(
  meta: { ip: string; userAgent: string | null },
  identifier: string,
  success: boolean,
  userId: string | null
): Promise<void> {
  try {
    const db = getDb();
    await db
      .prepare(
        `INSERT INTO login_attempts (identifier, ip, success, user_id, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`
      )
      .bind(identifier.slice(0, 190), meta.ip, success ? 1 : 0, userId, meta.userAgent)
      .run();
    await writeAudit(db, null, {
      action: success ? "AUTH_LOGIN_SUCCESS" : "AUTH_LOGIN_FAILED",
      entityType: "USER",
      entityId: userId,
      metadata: { identifier: identifier.slice(0, 190) },
      ip: meta.ip,
      userAgent: meta.userAgent
    });
  } catch (error) {
    logger.warn("Không ghi được login_attempts/audit", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
