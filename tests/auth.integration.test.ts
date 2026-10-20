import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { NextRequest } from "next/server";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "../lib/auth/password";
import {
  buildSessionCookie,
  createSession,
  hashSessionToken,
  resolveSession,
  revokeSessionByToken
} from "../lib/auth/session";
import { assertTrustedOrigin } from "../lib/auth/guard";
import { ForbiddenError, RateLimitError } from "../lib/errors";
import { consumeRateLimit } from "../lib/http/rate-limit";
import { getDatabaseName, loadEnv, optionalEnv } from "../lib/env";
import { parseDatabaseUrl } from "../lib/db/url";
import { closeDb, getDb } from "../lib/db";
import { runMigrations } from "../scripts/migrate";

loadEnv();
const databaseUrl = optionalEnv("DATABASE_URL");
if (!databaseUrl) {
  throw new Error(
    "test:auth yêu cầu DATABASE_URL trỏ tới database có tên kết thúc bằng _test. Không dùng database thật."
  );
}
const databaseName = getDatabaseName();
if (!databaseName.endsWith("_test")) {
  throw new Error(
    `TỪ CHỐI CHẠY TEST: database "${databaseName}" không kết thúc bằng _test. ` +
      "Đặt DATABASE_URL trỏ tới database test riêng, ví dụ pcm_opsflow_test."
  );
}
console.log(`[test:auth] Database được phép: ${databaseName}`);

let dbUnavailableReason: string | null = null;
before(async () => {
  try {
    const connection = await mysql.createConnection({
      ...parseDatabaseUrl(databaseUrl),
      connectTimeout: 3000
    });
    await connection.query("SELECT 1");
    await connection.end();
  } catch (error) {
    dbUnavailableReason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[test:auth] Không kết nối được MySQL, bỏ qua phần tích hợp DB: ${dbUnavailableReason}`
    );
  }
});

after(async () => {
  await closeDb().catch(() => undefined);
});

test("mật khẩu PBKDF2 tạo hash khác nhau và xác thực đúng", async () => {
  const password = "MatKhauRatManh#2026";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^pbkdf2-sha256\$210000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(`${password}x`, first), false);
  assert.equal(await verifyPassword(password, "không-phải-hash"), false);
});

test("chính sách mật khẩu nội bộ", () => {
  assert.equal(checkPasswordPolicy("ngan").ok, false);
  assert.equal(checkPasswordPolicy("abcdefghijkl").ok, false);
  assert.equal(checkPasswordPolicy("Abcdefgh1234").ok, true);
  assert.equal(checkPasswordPolicy("Abcdefgh1234!").ok, true);
  assert.equal(checkPasswordPolicy("A1!aaaaaaaaaaa").ok, true);
});

test("token phiên được hash SHA-256 và cookie có thuộc tính an toàn", () => {
  const token = randomBytes(32).toString("base64url");
  const hash = hashSessionToken(token);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, createHash("sha256").update(token, "utf8").digest("hex"));

  const expires = new Date("2026-12-31T00:00:00Z");
  const cookie = buildSessionCookie(token, expires);
  assert.equal(cookie.name, "pcm_session");
  assert.equal(cookie.value, token);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "lax");
  assert.equal(cookie.path, "/");
  assert.equal(cookie.expires.toISOString(), expires.toISOString());
  assert.equal(typeof cookie.secure, "boolean");
});

test("CSRF: origin lạ và cross-site bị từ chối, same-origin được phép", () => {
  const crossSite = new NextRequest("http://127.0.0.1:3000/api/auth/login", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site"
    }
  });
  assert.throws(() => assertTrustedOrigin(crossSite), ForbiddenError);

  const sameOrigin = new NextRequest("http://127.0.0.1:3000/api/auth/login", {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-origin"
    }
  });
  assert.doesNotThrow(() => assertTrustedOrigin(sameOrigin));
});

test("tích hợp MySQL: migrate, session và rate limit", async (t) => {
    if (dbUnavailableReason) {
      t.skip(`MySQL không khả dụng: ${dbUnavailableReason}`);
      return;
    }
    const migration = await runMigrations({ databaseUrl, silence: true });
    assert.ok(migration.alreadyApplied + migration.applied.length >= 1);

    const db = getDb();
    const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    const username = `test_auth_${suffix}`;
    const email = `${username}@example.test`;
    const password = "MatKhauTest#2026";
    const passwordHash = await hashPassword(password);
    const insert = await db
      .prepare(
        `INSERT INTO users
           (username, email, full_name, password_hash, role, is_active, created_at, updated_at)
         VALUES (?, ?, 'Test Auth', ?, 'ADMIN', 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
      )
      .bind(username, email, passwordHash)
      .run();
    const userId = String(insert.lastInsertId);

    try {
      const session = await createSession(userId, "127.0.0.1", "test:auth");
      assert.equal(session.token.includes("."), false);
      const resolved = await resolveSession(session.token);
      assert.ok(resolved);
      assert.equal(resolved.id, userId);
      assert.equal(resolved.role, "ADMIN");

      await revokeSessionByToken(session.token);
      assert.equal(await resolveSession(session.token), null);

      const scope = `test:auth:${suffix}`;
      const identifier = "same-client";
      await consumeRateLimit({ scope, identifier, limit: 2, windowSeconds: 60 });
      await consumeRateLimit({ scope, identifier, limit: 2, windowSeconds: 60 });
      await assert.rejects(
        () => consumeRateLimit({ scope, identifier, limit: 2, windowSeconds: 60 }),
        RateLimitError
      );

      const bucketKey = createHash("sha256").update(`${scope}\0${identifier}`, "utf8").digest("hex");
      await db.prepare("DELETE FROM rate_limits WHERE bucket_key = ?").bind(bucketKey).run();
    } finally {
      await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
    }
});
