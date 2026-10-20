import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { RateLimitError } from "@/lib/errors";

export interface RateLimitOptions {
  scope: string;
  identifier: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  remaining: number;
  retryAfterSeconds: number;
}

function hashKey(scope: string, identifier: string): string {
  return createHash("sha256").update(`${scope}\0${identifier}`, "utf8").digest("hex");
}

function dbDateTime(date: Date): string {
  return date.toISOString().slice(0, 23).replace("T", " ");
}

/**
 * Fixed-window rate limit nguyên tử trong MySQL. Bucket key được hash để
 * không lưu IP/identifier trực tiếp. Fail-closed nếu DB lỗi.
 */
export async function consumeRateLimit(options: RateLimitOptions): Promise<RateLimitResult> {
  if (options.limit < 1 || options.windowSeconds < 1) {
    throw new Error("Cấu hình rate limit không hợp lệ.");
  }
  const now = Date.now();
  const windowMs = options.windowSeconds * 1000;
  const bucketStartMs = Math.floor(now / windowMs) * windowMs;
  const bucketStart = new Date(bucketStartMs);
  const expiresAt = new Date(bucketStartMs + windowMs + 60_000);
  const retryAfterSeconds = Math.max(1, Math.ceil((bucketStartMs + windowMs - now) / 1000));
  const key = hashKey(options.scope, options.identifier);
  const db = getDb();

  await db
    .prepare(
      `INSERT INTO rate_limits (bucket_key, window_start, hits, expires_at)
       VALUES (?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE hits = hits + 1`
    )
    .bind(key, dbDateTime(bucketStart), dbDateTime(expiresAt))
    .run();

  const row = await db
    .prepare<{ hits: number | string }>(
      "SELECT hits FROM rate_limits WHERE bucket_key = ? AND window_start = ? LIMIT 1"
    )
    .bind(key, dbDateTime(bucketStart))
    .first();

  const hits = Number(row?.hits ?? 0);
  if (hits > options.limit) {
    throw new RateLimitError(retryAfterSeconds);
  }

  if (Math.random() < 0.02) {
    void db
      .prepare("DELETE FROM rate_limits WHERE expires_at < UTC_TIMESTAMP(3) LIMIT 500")
      .bind()
      .run()
      .catch(() => undefined);
  }

  return {
    remaining: Math.max(0, options.limit - hits),
    retryAfterSeconds
  };
}

export async function enforceLoginRateLimit(ip: string, identifier: string): Promise<void> {
  await Promise.all([
    consumeRateLimit({
      scope: "auth:login:ip",
      identifier: ip,
      // Văn phòng thường dùng chung một IP ra Internet; 30 lần/15 phút vẫn
      // chặn dò mật khẩu hàng loạt nhưng không khóa cả văn phòng quá sớm.
      limit: 30,
      windowSeconds: 15 * 60
    }),
    consumeRateLimit({
      scope: "auth:login:identifier",
      identifier: identifier.toLowerCase(),
      limit: 10,
      windowSeconds: 15 * 60
    })
  ]);
}

export async function enforceTrackingRateLimit(ip: string, code: string): Promise<void> {
  await Promise.all([
    consumeRateLimit({
      scope: "orders:track:ip",
      identifier: ip,
      limit: 30,
      windowSeconds: 60
    }),
    consumeRateLimit({
      scope: "orders:track:code",
      identifier: code.toUpperCase(),
      limit: 10,
      windowSeconds: 60
    })
  ]);
}
