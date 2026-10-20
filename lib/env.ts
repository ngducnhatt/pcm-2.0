import { config as loadDotenv } from "dotenv";

let loaded = false;

/**
 * Next.js tự nạp .env.local khi chạy. Hàm này giúp các script CLI (tsx)
 * dùng đúng thứ tự ưu tiên tương tự Next: .env.local trước, .env sau.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  // dotenv không ghi đè biến đã có, nên .env.local thắng .env.
  loadDotenv({ path: ".env.local", override: false, quiet: true });
  loadDotenv({ path: ".env", override: false, quiet: true });
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

export function requireEnv(name: string): string {
  loadEnv();
  const value = process.env[name]?.trim();
  if (!value) throw new EnvError(`Thiếu biến môi trường bắt buộc: ${name}`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  loadEnv();
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function envBool(name: string, defaultValue = false): boolean {
  const value = optionalEnv(name);
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function envInt(name: string, defaultValue: number): number {
  const value = optionalEnv(name);
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function getDatabaseUrl(): string {
  return requireEnv("DATABASE_URL");
}

/**
 * Tùy chọn tách tài khoản migrate (có quyền DDL) khỏi tài khoản runtime.
 * Nếu không khai báo, dùng DATABASE_URL.
 */
export function getMigrateDatabaseUrl(): string {
  return optionalEnv("MIGRATE_DATABASE_URL") ?? getDatabaseUrl();
}

/** Tùy chọn dùng tài khoản chỉ-đọc cho mysqldump. */
export function getBackupDatabaseUrl(): string {
  return optionalEnv("BACKUP_DATABASE_URL") ?? getDatabaseUrl();
}

export function getDatabaseName(): string {
  const raw = getDatabaseUrl();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new EnvError("DATABASE_URL không phải URL hợp lệ.");
  }
  if (!["mysql:", "mysql2:"].includes(parsed.protocol)) {
    throw new EnvError("DATABASE_URL phải có protocol mysql://.");
  }
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!dbName || !/^[A-Za-z0-9_]+$/.test(dbName)) {
    throw new EnvError("DATABASE_URL phải có tên database hợp lệ.");
  }
  return dbName;
}

export function getPublicUrl(): string | undefined {
  const value = optionalEnv("APP_PUBLIC_URL");
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function getSessionTtlHours(): number {
  return Math.min(Math.max(envInt("SESSION_TTL_HOURS", 12), 1), 24 * 30);
}

export function getPoolMax(): number {
  return Math.min(Math.max(envInt("PG_POOL_MAX", 10), 1), 50);
}

export function getTrustProxy(): boolean {
  return envBool("TRUST_PROXY", false);
}

export function getProxyMode(): "auto" | "cloudflare" | "caddy" {
  const mode = (optionalEnv("PROXY_MODE") ?? "auto").toLowerCase();
  return mode === "cloudflare" || mode === "caddy" ? mode : "auto";
}

export function getCookieSecure(): boolean {
  const explicit = optionalEnv("COOKIE_SECURE");
  if (explicit !== undefined) return ["1", "true", "yes", "on"].includes(explicit.toLowerCase());
  return process.env.NODE_ENV === "production";
}

export function getBackupKeep(): number {
  return Math.max(envInt("BACKUP_KEEP", 14), 1);
}

export function getBackupDir(): string {
  return optionalEnv("BACKUP_DIR") ?? "backups";
}

export function getLogKeepDays(): number {
  return Math.max(envInt("LOG_KEEP_DAYS", 30), 1);
}
