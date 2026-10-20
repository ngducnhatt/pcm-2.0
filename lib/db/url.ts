export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * Phân tích DATABASE_URL dạng mysql://user:password@host:port/database.
 * Mật khẩu phải được URL-encode trong file .env.
 */
export function parseDatabaseUrl(raw: string): DatabaseConfig {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL không phải URL hợp lệ.");
  }
  if (!["mysql:", "mysql2:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL phải bắt đầu bằng mysql:// hoặc mysql2://.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!database) throw new Error("DATABASE_URL thiếu tên database.");
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error("Tên database chỉ được chứa chữ, số và dấu gạch dưới.");
  }
  const user = decodeURIComponent(url.username);
  if (!user) throw new Error("DATABASE_URL thiếu tên đăng nhập MySQL.");
  const port = url.port ? Number(url.port) : 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Cổng MySQL trong DATABASE_URL không hợp lệ.");
  }
  return {
    host: url.hostname || "127.0.0.1",
    port,
    user,
    password: decodeURIComponent(url.password),
    database
  };
}
