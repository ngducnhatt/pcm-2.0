import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket
} from "mysql2/promise";
import type { Connection as CoreConnection } from "mysql2";
import { getDatabaseUrl, getPoolMax } from "@/lib/env";
import { parseDatabaseUrl } from "@/lib/db/url";

export type SqlValue = string | number | bigint | boolean | null | Date | Buffer;

export interface RunResult {
  changes: number;
  lastInsertId: string | number;
}

export interface Statement<T> {
  all(): Promise<T[]>;
  first(): Promise<T | null>;
  run(): Promise<RunResult>;
}

export interface PreparedStatement<T> {
  bind(...params: SqlValue[]): Statement<T>;
}

export interface DbExecutor {
  prepare<T = Record<string, unknown>>(sql: string): PreparedStatement<T>;
}

class MysqlStatement<T> implements Statement<T> {
  constructor(
    private readonly executor: Pool | PoolConnection,
    private readonly sql: string,
    private readonly params: SqlValue[]
  ) {}

  async all(): Promise<T[]> {
    const [rows] = await this.executor.query(this.sql, this.params);
    return rows as T[];
  }

  async first(): Promise<T | null> {
    const rows = await this.all();
    return rows.length > 0 ? rows[0] : null;
  }

  async run(): Promise<RunResult> {
    const [result] = await this.executor.query(this.sql, this.params);
    if (Array.isArray(result)) {
      return { changes: result.length, lastInsertId: 0 };
    }
    const header = result as ResultSetHeader;
    return {
      changes: header.affectedRows ?? 0,
      lastInsertId: header.insertId ?? 0
    };
  }
}

class MysqlExecutor implements DbExecutor {
  constructor(private readonly executor: Pool | PoolConnection) {}

  prepare<T = Record<string, unknown>>(sql: string): PreparedStatement<T> {
    return {
      bind: (...params: SqlValue[]) => new MysqlStatement<T>(this.executor, sql, params)
    };
  }
}

function connectionConfig() {
  const { host, port, user, password, database } = parseDatabaseUrl(getDatabaseUrl());
  return {
    host,
    port,
    user,
    password,
    database,
    charset: "utf8mb4_unicode_ci",
    timezone: "Z",
    dateStrings: true as const,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    waitForConnections: true,
    connectionLimit: getPoolMax(),
    maxIdle: getPoolMax(),
    idleTimeout: 60_000,
    queueLimit: 0,
    connectTimeout: 15_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    multipleStatements: false
  };
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool(connectionConfig());
    // dateStrings + timezone Z giúp dữ liệu luôn được hiểu là UTC.
    // Đặt múi giờ session để NOW()/CURRENT_TIMESTAMP cũng là UTC.
    pool.on("connection", (connection) => {
      // Sự kiện này của mysql2/promise thực tế trả về connection callback-style
      // (typings ghi là PoolConnection). Ép kiểu để dùng đúng API callback.
      const core = connection as unknown as CoreConnection;
      core.query("SET time_zone = '+00:00'", () => {
        // Không log lỗi kết nối để tránh lộ thông tin; transaction tự SET lại.
      });
    });
  }
  return pool;
}

export function getDb(): DbExecutor {
  return new MysqlExecutor(getPool());
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableTransactionError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const errno = (error as { errno?: number } | null)?.errno;
  return (
    code === "ER_LOCK_DEADLOCK" ||
    code === "ER_LOCK_WAIT_TIMEOUT" ||
    errno === 1213 ||
    errno === 1205
  );
}

const TRANSACTION_ATTEMPTS = 3;

/**
 * Chạy callback trong một transaction InnoDB. Callback PHẢI dùng query được
 * truyền vào, không dùng getDb(), để mọi thao tác nằm trong cùng transaction.
 * Deadlock được retry tối đa 3 lần với backoff ngẫu nhiên.
 */
export async function withTransaction<T>(
  callback: (query: DbExecutor) => Promise<T>
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= TRANSACTION_ATTEMPTS; attempt += 1) {
    const connection = await getPool().getConnection();
    try {
      await connection.query("SET time_zone = '+00:00'");
      await connection.query("SET SESSION innodb_lock_wait_timeout = 10");
      await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await connection.beginTransaction();
      const query = new MysqlExecutor(connection);
      const result = await callback(query);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // Bỏ qua lỗi rollback để giữ lỗi gốc.
      }
      lastError = error;
      if (attempt < TRANSACTION_ATTEMPTS && isRetryableTransactionError(error)) {
        await sleep(40 * attempt + Math.floor(Math.random() * 80));
        continue;
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Transaction thất bại.");
}

export function isDuplicateKeyError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const errno = (error as { errno?: number } | null)?.errno;
  return code === "ER_DUP_ENTRY" || errno === 1062;
}

export type DbRow = RowDataPacket;
