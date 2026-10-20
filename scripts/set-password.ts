import { closeDb, withTransaction } from "../lib/db";
import { loadEnv, optionalEnv } from "../lib/env";
import { checkPasswordPolicy, hashPassword } from "../lib/auth/password";
import { revokeUserSessionsTx } from "../lib/auth/session";
import { writeAudit } from "../lib/services/audit";
import { promptHidden, promptLine } from "./cli-utils";

function parseTarget(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--username" || arg === "-u") return args[i + 1];
    if (arg.startsWith("--username=")) return arg.slice("--username=".length);
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

async function readPassword(): Promise<string> {
  const fromEnv = optionalEnv("NEW_PASSWORD");
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error(
      "Không có NEW_PASSWORD và stdin không phải terminal. Hãy đặt NEW_PASSWORD trong biến môi trường."
    );
  }
  const first = await promptHidden("Mật khẩu mới: ");
  const second = await promptHidden("Nhập lại mật khẩu: ");
  if (first !== second) throw new Error("Hai lần nhập mật khẩu không khớp.");
  return first;
}

async function main(): Promise<void> {
  loadEnv();
  const targetRaw = parseTarget() ?? optionalEnv("PCM_USERNAME") ?? (await promptLine("Tên đăng nhập hoặc email: "));
  const target = targetRaw.trim().toLowerCase();
  if (!target) throw new Error("Thiếu tên đăng nhập hoặc email.");

  const password = await readPassword();
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) throw new Error(policy.message ?? "Mật khẩu không đủ mạnh.");
  const passwordHash = await hashPassword(password);

  const result = await withTransaction(async (query) => {
    const user = await query
      .prepare<{
        id: string;
        username: string;
        email: string;
        is_active: number;
      }>(
        `SELECT id, username, email, is_active
         FROM users WHERE username = ? OR email = ? LIMIT 1 FOR UPDATE`
      )
      .bind(target, target)
      .first();
    if (!user) throw new Error("Không tìm thấy người dùng.");

    await query
      .prepare(
        `UPDATE users SET password_hash = ?, password_changed_at = UTC_TIMESTAMP(3),
           failed_login_attempts = 0, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
         WHERE id = ?`
      )
      .bind(passwordHash, user.id)
      .run();
    const revoked = await revokeUserSessionsTx(query, user.id);
    await writeAudit(query, null, {
      action: "USER_PASSWORD_SET_CLI",
      entityType: "USER",
      entityId: user.id,
      metadata: { username: user.username, revokedSessions: revoked, via: "user:password" }
    });
    return {
      username: user.username,
      isActive: Boolean(user.is_active),
      revoked
    };
  });

  console.log(`✓ Đã đặt lại mật khẩu cho ${result.username}; thu hồi ${result.revoked} phiên đăng nhập.`);
  if (!result.isActive) {
    console.warn("  Cảnh báo: tài khoản đang bị khóa (is_active = 0); cần kích hoạt trước khi đăng nhập.");
  }
}

main()
  .catch((error) => {
    console.error("✗ Đặt mật khẩu thất bại:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => undefined);
  });
