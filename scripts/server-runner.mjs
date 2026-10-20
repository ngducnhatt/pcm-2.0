#!/usr/bin/env node
/**
 * PCM OpsFlow - production process runner cho Windows/XAMPP.
 *
 * - Chỉ bind 127.0.0.1 (không bao giờ mở trực tiếp ra LAN/Internet).
 * - Ghi log xoay vòng theo ngày/kích thước, tự dọn log cũ.
 * - Tự khởi động lại Next.js nếu process con thoát bất thường.
 * - PID file ngăn chạy trùng hai instance.
 *
 * Chạy: npm run serve
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ path: ".env", quiet: true });

const ROOT = process.cwd();
const BIND_HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const LOG_DIR = path.resolve(ROOT, process.env.LOG_DIR ?? "logs");
const LOG_MAX_BYTES = Math.max(
  Number.parseInt(process.env.LOG_MAX_BYTES ?? String(10 * 1024 * 1024), 10) || 10 * 1024 * 1024,
  1024 * 1024
);
const LOG_KEEP_DAYS = Math.max(Number.parseInt(process.env.LOG_KEEP_DAYS ?? "30", 10) || 30, 1);
const MAX_RESTARTS = 8;
const STABLE_RUN_MS = 10 * 60 * 1000;
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const BUILD_ID = path.join(ROOT, ".next", "BUILD_ID");
const PID_FILE = path.join(LOG_DIR, "pcm-opsflow.pid");

class RotatingLog {
  constructor(directory, maxBytes, keepDays) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.keepDays = keepDays;
    this.day = null;
    this.file = null;
    this.stream = null;
    this.bytes = 0;
    mkdirSync(this.directory, { recursive: true });
  }

  ensureOpen() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.stream && this.day === day) return;
    if (this.stream) this.close();
    this.day = day;
    this.file = path.join(this.directory, `app-${day}.log`);
    this.stream = createWriteStream(this.file, { flags: "a" });
    this.stream.on("error", (error) => {
      console.error(`[runner] Không ghi được log: ${error.message}`);
      this.stream = null;
    });
    try {
      this.bytes = statSync(this.file).size;
    } catch {
      this.bytes = 0;
    }
  }

  write(kind, data) {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    if (!text) return;
    this.ensureOpen();
    if (!this.stream) return;
    const line = `[${new Date().toISOString()}] [${kind}] ${text}`;
    this.stream.write(line);
    this.bytes += Buffer.byteLength(line, "utf8");
    if (this.bytes >= this.maxBytes) this.rotate();
  }

  rotate() {
    const oldFile = this.file;
    this.close();
    if (oldFile) {
      const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 17);
      try {
        renameSync(oldFile, path.join(this.directory, `app-${this.day}-${stamp}.log`));
      } catch {
        // Nếu không đổi tên được (file đang bị khóa), tiếp tục ghi nối.
      }
    }
    this.bytes = 0;
    this.ensureOpen();
  }

  cleanup() {
    const cutoff = Date.now() - this.keepDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    try {
      for (const name of readdirSync(this.directory)) {
        if (!/^app-\d{4}-\d{2}-\d{2}.*\.log$/.test(name)) continue;
        const full = path.join(this.directory, name);
        try {
          if (statSync(full).mtimeMs < cutoff) {
            unlinkSync(full);
            removed += 1;
          }
        } catch {
          // File có thể vừa bị xoay vòng; bỏ qua.
        }
      }
    } catch {
      // Không đọc được thư mục log: không làm sập ứng dụng.
    }
    if (removed > 0) log.write("INFO", `Đã dọn ${removed} file log cũ hơn ${this.keepDays} ngày.`);
  }

  close() {
    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        // Bỏ qua.
      }
      this.stream = null;
    }
  }
}

const log = new RotatingLog(LOG_DIR, LOG_MAX_BYTES, LOG_KEEP_DAYS);

function stop(code) {
  log.close();
  process.exit(code);
}

function fatal(message) {
  log.write("ERROR", message);
  console.error(`[runner] ${message}`);
  releasePidFile();
  stop(1);
}

function readPidFile() {
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim();
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function releasePidFile() {
  try {
    if (readPidFile() === process.pid) unlinkSync(PID_FILE);
  } catch {
    // Không có file hoặc đã bị xóa.
  }
}

function acquirePidFile() {
  mkdirSync(LOG_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(PID_FILE, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        fatal(`Không tạo được PID file tại ${PID_FILE}: ${error?.message ?? error}`);
      }
      const existing = readPidFile();
      if (existing && existing !== process.pid && isProcessAlive(existing)) {
        fatal(`PCM OpsFlow đang chạy với PID ${existing}. Dừng instance cũ trước khi chạy lại.`);
      }
      try {
        unlinkSync(PID_FILE);
      } catch {
        // Thử lại lần cuối.
      }
    }
  }
  fatal("Không thể giành PID file; có một instance khác đang khởi động.");
}

function validateConfig() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    fatal(`PORT không hợp lệ: ${process.env.PORT}. Dùng số từ 1 đến 65535.`);
  }
  if (!process.env.DATABASE_URL) {
    fatal("Thiếu DATABASE_URL. Tạo .env.local từ .env.example và điền thông tin MySQL.");
  }
  if (!existsSync(NEXT_BIN)) {
    fatal("Không tìm thấy Next.js CLI. Chạy npm install trước.");
  }
  if (!existsSync(BUILD_ID)) {
    fatal("Chưa có bản build production (.next/BUILD_ID). Chạy npm run build trước.");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let child = null;
let stopping = false;
let restartCount = 0;
let childStartedAt = 0;
let readinessGeneration = 0;

async function reportReadiness(generation) {
  const deadline = Date.now() + 60_000;
  let lastError = "";
  while (!stopping && generation === readinessGeneration && Date.now() < deadline) {
    try {
      const response = await fetch(`http://${BIND_HOST}:${PORT}/api/health`, {
        signal: AbortSignal.timeout(3000),
        headers: { "user-agent": "pcm-opsflow-runner" }
      });
      if (response.ok) {
        log.write("INFO", `Health check OK tại http://${BIND_HOST}:${PORT}/api/health`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000);
  }
  if (!stopping && generation === readinessGeneration) {
    log.write(
      "WARN",
      `Health check chưa OK sau 60 giây (${lastError || "timeout"}). Kiểm tra MySQL và log ứng dụng.`
    );
  }
}

function startChild() {
  if (stopping) return;
  childStartedAt = Date.now();
  readinessGeneration += 1;
  const generation = readinessGeneration;
  log.write(
    "INFO",
    `Khởi động Next.js: ${BIND_HOST}:${PORT} (pid cha ${process.pid}, lần thử ${restartCount + 1})`
  );

  const spawned = spawn(
    process.execPath,
    [NEXT_BIN, "start", "--hostname", BIND_HOST, "--port", String(PORT)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOSTNAME: BIND_HOST,
        PORT: String(PORT),
        NEXT_TELEMETRY_DISABLED: "1"
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child = spawned;

  spawned.stdout.on("data", (data) => log.write("OUT", data));
  spawned.stderr.on("data", (data) => log.write("ERR", data));

  spawned.on("error", (error) => {
    log.write("ERROR", `Không spawn được Next.js: ${error.message}`);
  });

  spawned.on("exit", (code, signal) => {
    if (child === spawned) child = null;
    log.write("INFO", `Next.js đã thoát (code=${code}, signal=${signal ?? "none"}).`);
    if (stopping) {
      releasePidFile();
      stop(0);
    }
    if (Date.now() - childStartedAt > STABLE_RUN_MS) restartCount = 0;
    restartCount += 1;
    if (restartCount > MAX_RESTARTS) {
      log.write("ERROR", `Next.js thoát ${MAX_RESTARTS} lần liên tiếp. Dừng runner để tránh vòng lặp.`);
      releasePidFile();
      stop(1);
    }
    const delay = Math.min(30_000, 2_000 * 2 ** (restartCount - 1));
    log.write("WARN", `Khởi động lại sau ${delay} ms (lần ${restartCount}/${MAX_RESTARTS}).`);
    setTimeout(startChild, delay);
  });

  void reportReadiness(generation);
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  readinessGeneration += 1;
  log.write("INFO", `Nhận ${signal}, đang dừng PCM OpsFlow...`);
  const current = child;
  if (!current) {
    releasePidFile();
    stop(0);
  }
  try {
    current.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
  } catch {
    // Process có thể đã thoát.
  }
  const hardStop = setTimeout(() => {
    log.write("WARN", "Next.js không thoát sau 15 giây; buộc dừng.");
    try {
      current.kill("SIGKILL");
    } catch {
      // Bỏ qua.
    }
    releasePidFile();
    stop(0);
  }, 15_000);
  hardStop.unref?.();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", releasePidFile);
process.on("uncaughtException", (error) => {
  log.write("ERROR", `Lỗi không xử lý: ${error.stack ?? error.message}`);
  releasePidFile();
  stop(1);
});
process.on("unhandledRejection", (reason) => {
  log.write("ERROR", `Promise bị từ chối: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

validateConfig();
acquirePidFile();
log.cleanup();
log.write(
  "INFO",
  `PCM OpsFlow runner khởi động (pid ${process.pid}, Node ${process.version}, log ${LOG_DIR}).`
);
console.log(`PCM OpsFlow đang chạy tại http://${BIND_HOST}:${PORT} (log: ${LOG_DIR})`);
startChild();

const cleanupTimer = setInterval(() => log.cleanup(), 24 * 60 * 60 * 1000);
cleanupTimer.unref?.();
