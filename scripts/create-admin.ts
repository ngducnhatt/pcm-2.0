import { closeDb, getDb, withTransaction } from "../lib/db";
import { loadEnv, optionalEnv } from "../lib/env";
import { checkPasswordPolicy, hashPassword } from "../lib/auth/password";
import { writeAudit } from "../lib/services/audit";
import { promptHidden, promptLine } from "./cli-utils";

const PLACEHOLDER_PASSWORDS = new Set([
  "CHANGE_ME",
  "CHANGE_ME_TO_A_STRONG_PASSWORD",
  "PASSWORD",
  "ADMIN"
]);

function validateUsername(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!/^[a-zA-Z0-9._-]{3,50}$/.test(value)) {
    throw new Error(
      "Tên đăng nhập phải dài 3-50 ký tự, chỉ gồm chữ, số, dấu chấm, gạch dưới hoặc gạch ngang."
    );
  }
  return value;
}

function validateEmail(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value.length > 190 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error("Email không hợp lệ.");
  }
  return value;
}

function validateFullName(raw: string): string {
  const value = raw.trim();
  if (value.length < 2 || value.length > 120) {
    throw new Error("Họ tên phải dài 2-120 ký tự.");
  }
  return value;
}

async function readPassword(): Promise<string> {
  const fromEnv = optionalEnv("ADMIN_PASSWORD");
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error(
      "Không có ADMIN_PASSWORD và stdin không phải terminal. Hãy đặt ADMIN_PASSWORD trong .env.local hoặc biến môi trường."
    );
  }
  const first = await promptHidden("Mật khẩu admin mới: ");
  const second = await promptHidden("Nhập lại mật khẩu: ");
  if (first !== second) throw new Error("Hai lần nhập mật khẩu không khớp.");
  return first;
}

async function main(): Promise<void> {
  loadEnv();
  const force = process.argv.slice(2).includes("--force");

  const username = validateUsername(
    optionalEnv("ADMIN_USERNAME") ?? (await promptLine("Tên đăng nhập admin: "))
  );
  const email = validateEmail(optionalEnv("ADMIN_EMAIL") ?? (await promptLine("Email admin: ")));
  const fullName = validateFullName(
    optionalEnv("ADMIN_NAME") ?? (await promptLine("Họ tên admin: "))
  );
  const password = await readPassword();

  if (PLACEHOLDER_PASSWORDS.has(password)) {
    throw new Error("Mật khẩu vẫn là giá trị mẫu. Hãy đổi sang mật khẩu mạnh.");
  }
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) throw new Error(policy.message ?? "Mật khẩu không đủ mạnh.");

  const db = getDb();
  const userCount = await db
    .prepare<{ total: number | string }>("SELECT COUNT(*) AS total FROM users")
    .bind()
    .first();
  if (Number(userCount?.total ?? 0) > 0 && !force) {
    throw new Error(
      "Database đã có người dùng. Dùng API quản trị để tạo thêm tài khoản, hoặc chạy lại với --force nếu đây là bootstrap khẩn cấp."
    );
  }

  const existing = await db
    .prepare<{ id: string }>("SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1")
    .bind(username, email)
    .first();
  if (existing) {
    throw new Error("Tên đăng nhập hoặc email đã tồn tại.");
  }

  const passwordHash = await hashPassword(password);
  const userId = await withTransaction(async (query) => {
    const result = await query
      .prepare(
        `INSERT INTO users
           (username, email, full_name, password_hash, role, is_active,
            created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ADMIN', 1, NULL, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
      )
      .bind(username, email, fullName, passwordHash)
      .run();
    const id = String(result.lastInsertId);
    await writeAudit(query, null, {
      action: "ADMIN_BOOTSTRAP",
      entityType: "USER",
      entityId: id,
      after: { username, email, fullName, role: "ADMIN", isActive: true },
      metadata: { via: "db:admin", forced: force }
    });
    return id;
  });

  console.log(`✓ Đã tạo tài khoản ADMIN #${userId} (${username}).`);
  console.log("  Không có mật khẩu nào được ghi log. Hãy đổi mật khẩu sau lần đăng nhập đầu tiên.");
}

main()
  .catch((error) => {
    console.error("✗ Tạo admin thất bại:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => undefined);
  });
