import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { getMigrateDatabaseUrl, loadEnv, requireEnv } from "../lib/env";
import { parseDatabaseUrl } from "../lib/db/url";

interface MigrationFile {
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

interface AppliedMigration extends RowDataPacket {
  version: string;
  filename: string;
  checksum: string;
}

const MIGRATION_RE = /^(\d{3,})_([a-z0-9_-]+)\.sql$/i;

/**
 * Tách file .sql thành từng statement. Hỗ trợ quote, escape, comment dòng
 * (`-- ` và `#`) và comment khối. Không hỗ trợ lệnh DELIMITER của mysql CLI.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
    const next = sql[i + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        current += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      current += char;
      if (char === "\\" && quote !== "`") {
        if (next !== undefined) {
          current += next;
          i += 1;
        }
        continue;
      }
      if (char === quote) {
        if (next === quote) {
          current += next;
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }

    if (
      char === "-" &&
      next === "-" &&
      (sql[i + 2] === " " || sql[i + 2] === "\t" || sql[i + 2] === "\r" || sql[i + 2] === "\n")
    ) {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === "#") {
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

function loadMigrations(directory: string): MigrationFile[] {
  const files = readdirSync(directory)
    .filter((filename) => MIGRATION_RE.test(filename))
    .sort((left, right) => left.localeCompare(right, "en"));
  const seen = new Set<string>();
  return files.map((filename) => {
    const match = MIGRATION_RE.exec(filename)!;
    const version = match[1]!;
    if (seen.has(version)) {
      throw new Error(`Trùng số migration: ${version}`);
    }
    seen.add(version);
    const sql = readFileSync(path.join(directory, filename), "utf8");
    const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
    return { version, filename, sql, checksum };
  });
}

export async function runMigrations(
  options: { databaseUrl?: string; directory?: string; silence?: boolean } = {}
): Promise<{
  applied: string[];
  alreadyApplied: number;
}> {
  loadEnv();
  const databaseUrl = options.databaseUrl ?? getMigrateDatabaseUrl();
  const config = parseDatabaseUrl(databaseUrl);
  const directory = options.directory ?? path.join(process.cwd(), "migrations");
  const migrations = loadMigrations(directory);
  if (migrations.length === 0) throw new Error("Không tìm thấy file migration nào.");

  const connection = await mysql.createConnection({
    ...config,
    charset: "utf8mb4_unicode_ci",
    timezone: "Z",
    dateStrings: true,
    multipleStatements: false,
    connectTimeout: 15_000
  });
  // Chỉ hash phần host/database để lock ổn định, không đưa mật khẩu vào tên lock.
  const lockName = `pcm_opsflow_migrate_${createHash("sha256")
    .update(`${config.host}:${config.port}/${config.database}`)
    .digest("hex")
    .slice(0, 20)}`;

  try {
    await connection.query("SET time_zone = '+00:00'");
    const [lockRows] = await connection.query<Array<RowDataPacket & { locked: number | null }>>(
      "SELECT GET_LOCK(?, 30) AS locked",
      [lockName]
    );
    if (!lockRows[0] || Number(lockRows[0].locked) !== 1) {
      throw new Error("Không lấy được migration lock. Có tiến trình migrate khác đang chạy?");
    }

    await connection.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version VARCHAR(100) NOT NULL,
         filename VARCHAR(255) NOT NULL,
         checksum CHAR(64) NOT NULL,
         applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         PRIMARY KEY (version)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    const [appliedRows] = await connection.query<AppliedMigration[]>(
      "SELECT version, filename, checksum FROM schema_migrations ORDER BY version ASC"
    );
    const appliedMap = new Map(appliedRows.map((row) => [row.version, row]));

    for (const applied of appliedRows) {
      const local = migrations.find((migration) => migration.version === applied.version);
      if (!local) {
        throw new Error(
          `Database đã áp dụng migration ${applied.version} nhưng file không còn tồn tại. Không tự ý xóa lịch sử migration.`
        );
      }
      if (local.checksum !== applied.checksum) {
        throw new Error(
          `Migration ${applied.filename} đã bị sửa sau khi áp dụng. Hãy tạo migration mới thay vì sửa file cũ.`
        );
      }
    }

    const applied: string[] = [];
    for (const migration of migrations) {
      if (appliedMap.has(migration.version)) continue;
      if (!options.silence) console.log(`→ Áp dụng ${migration.filename}`);
      const statements = splitSqlStatements(migration.sql);
      await connection.beginTransaction();
      try {
        for (const statement of statements) {
          await connection.query(statement);
        }
        await connection.query(
          `INSERT INTO schema_migrations (version, filename, checksum, applied_at)
           VALUES (?, ?, ?, UTC_TIMESTAMP(3))`,
          [migration.version, migration.filename, migration.checksum]
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      }
      applied.push(migration.version);
    }

    if (!options.silence) {
      console.log(
        applied.length > 0
          ? `✓ Đã áp dụng ${applied.length} migration.`
          : "✓ Database đã ở phiên bản mới nhất."
      );
      console.log(
        "Lưu ý: MySQL/MariaDB tự động commit DDL, nên transaction chỉ bảo vệ phần ghi schema_migrations; migration lỗi giữa chừng cần được xử lý thủ công."
      );
    }
    return { applied, alreadyApplied: migrations.length - applied.length };
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => undefined);
    await connection.end();
  }
}

async function main(): Promise<void> {
  loadEnv();
  requireEnv("DATABASE_URL");
  await runMigrations();
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error) => {
    console.error("✗ Migration thất bại:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
