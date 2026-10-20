import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { getDb, withTransaction, type DbExecutor } from "@/lib/db";
import { getCookieSecure, getSessionTtlHours } from "@/lib/env";
import { isRole, type Role } from "@/lib/domain/roles";
import { UnauthorizedError } from "@/lib/errors";

export const SESSION_COOKIE_NAME = "pcm_session";
const LAST_SEEN_TOUCH_MS = 2 * 60 * 1000;

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  fullName: string;
  role: Role;
  sessionTokenHash: string;
  sessionExpiresAt: Date;
}

interface SessionRow {
  session_user_id: string;
  token_hash: string;
  expires_at: string;
  username: string;
  email: string;
  full_name: string;
  role: string;
  is_active: number;
  last_seen_at: string;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface CreatedSession {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export async function createSession(
  userId: string,
  ip: string | null,
  userAgent: string | null,
  query?: DbExecutor
): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + getSessionTtlHours() * 60 * 60 * 1000);
  const db = query ?? getDb();
  await db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, ip, user_agent, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), ?)`
    )
    .bind(
      tokenHash,
      userId,
      ip,
      userAgent ? userAgent.slice(0, 512) : null,
      expiresAt.toISOString().slice(0, 23).replace("T", " ")
    )
    .run();

  // Dọn phiên hết hạn của chính user này, không ảnh hưởng phiên đang dùng.
  await db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < UTC_TIMESTAMP(3) LIMIT 20")
    .bind(userId)
    .run();

  return { token, tokenHash, expiresAt };
}

export function getSessionTokenFromRequest(request: NextRequest): string | null {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token || token.length < 20 || token.length > 200) return null;
  return token;
}

export async function resolveSession(token: string): Promise<SessionUser | null> {
  const tokenHash = hashSessionToken(token);
  const db = getDb();
  const row = await db
    .prepare<SessionRow>(
      `SELECT s.user_id AS session_user_id, s.token_hash, s.expires_at,
              u.username, u.email, u.full_name, u.role, u.is_active, s.last_seen_at
       FROM sessions s
       INNER JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > UTC_TIMESTAMP(3)
         AND u.is_active = 1
       LIMIT 1`
    )
    .bind(tokenHash)
    .first();

  if (!row || !isRole(row.role)) return null;

  const expiresAt = parseDbDate(row.expires_at);
  if (!expiresAt || expiresAt.getTime() <= Date.now()) return null;

  const lastSeen = parseDbDate(row.last_seen_at);
  if (!lastSeen || Date.now() - lastSeen.getTime() > LAST_SEEN_TOUCH_MS) {
    // Không chặn request vì cập nhật last_seen; lỗi ở đây không làm mất phiên.
    void db
      .prepare("UPDATE sessions SET last_seen_at = UTC_TIMESTAMP(3) WHERE token_hash = ? AND revoked_at IS NULL")
      .bind(tokenHash)
      .run()
      .catch(() => undefined);
  }

  return {
    id: String(row.session_user_id),
    username: row.username,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    sessionTokenHash: row.token_hash,
    sessionExpiresAt: expiresAt
  };
}

export async function revokeSessionByToken(token: string): Promise<void> {
  await getDb()
    .prepare("UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(hashSessionToken(token))
    .run();
}

export async function revokeUserSessions(
  userId: string,
  exceptTokenHash?: string
): Promise<number> {
  const result = exceptTokenHash
    ? await getDb()
        .prepare(
          "UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND token_hash <> ? AND revoked_at IS NULL"
        )
        .bind(userId, exceptTokenHash)
        .run()
    : await getDb()
        .prepare(
          "UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL"
        )
        .bind(userId)
        .run();
  return result.changes;
}

export async function revokeUserSessionsTx(
  query: DbExecutor,
  userId: string,
  exceptTokenHash?: string
): Promise<number> {
  if (exceptTokenHash) {
    const result = await query
      .prepare(
        "UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND token_hash <> ? AND revoked_at IS NULL"
      )
      .bind(userId, exceptTokenHash)
      .run();
    return result.changes;
  }
  const result = await query
    .prepare("UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL")
    .bind(userId)
    .run();
  return result.changes;
}

export function buildSessionCookie(token: string, expiresAt: Date): {
  name: string;
  value: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  expires: Date;
} {
  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: getCookieSecure(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt
  };
}

export function buildClearedSessionCookie(): {
  name: string;
  value: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  expires: Date;
} {
  return {
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: getCookieSecure(),
    sameSite: "lax",
    path: "/",
    expires: new Date(0)
  };
}

export async function authenticateRequest(request: NextRequest): Promise<SessionUser> {
  const token = getSessionTokenFromRequest(request);
  if (!token) throw new UnauthorizedError();
  const user = await resolveSession(token);
  if (!user) throw new UnauthorizedError("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
  return user;
}

export async function countActiveAdmins(query?: DbExecutor): Promise<number> {
  const db = query ?? getDb();
  const row = await db
    .prepare<{ total: number | string }>(
      "SELECT COUNT(*) AS total FROM users WHERE role = 'ADMIN' AND is_active = 1"
    )
    .bind()
    .first();
  return Number(row?.total ?? 0);
}

function parseDbDate(value: string | null): Date | null {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Giữ chữ ký withTransaction để tránh import thừa và hỗ trợ các script sau này.
export { withTransaction };
