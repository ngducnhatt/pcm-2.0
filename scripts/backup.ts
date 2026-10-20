import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  getBackupDatabaseUrl,
  getBackupDir,
  getBackupKeep,
  loadEnv,
  optionalEnv
} from "../lib/env";
import { parseDatabaseUrl } from "../lib/db/url";

function fileTimestamp(date = new Date()): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}_${iso.slice(11, 19).replace(/:/g, "")}`;
}

function removeQuietly(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Không có file hoặc đang bị khóa: bỏ qua.
  }
}

function assertDumpLooksValid(filePath: string, database: string): void {
  const size = statSync(filePath).size;
  if (size < 1024) {
    throw new Error(`File dump quá nhỏ (${size} byte), có thể mysqldump đã thất bại.`);
  }
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, read).toString("utf8");
    if (!/CREATE TABLE/i.test(head)) {
      throw new Error("File dump không chứa CREATE TABLE; từ chối coi là bản sao lưu hợp lệ.");
    }
    if (!head.includes(database)) {
      throw new Error("File dump không đề cập tên database mong đợi; kiểm tra DATABASE_URL.");
    }
  } finally {
    closeSync(fd);
  }
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function applyRetention(directory: string, database: string, keep: number): string[] {
  const prefix = `${database}_`;
  const files = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".sql"))
    .map((name) => {
      const fullPath = path.join(directory, name);
      return { name, fullPath, mtime: statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.mtime - left.mtime);

  const removed: string[] = [];
  for (const item of files.slice(keep)) {
    removeQuietly(item.fullPath);
    removeQuietly(`${item.fullPath}.sha256`);
    removed.push(item.name);
  }
  return removed;
}

async function main(): Promise<void> {
  loadEnv();
  const config = parseDatabaseUrl(getBackupDatabaseUrl());
  const backupDir = path.resolve(process.cwd(), getBackupDir());
  const keep = getBackupKeep();
  const dumpBinary = optionalEnv("MYSQLDUMP_PATH") ?? "mysqldump";
  if (path.isAbsolute(dumpBinary) && !existsSync(dumpBinary)) {
    throw new Error(`Không tìm thấy mysqldump tại MYSQLDUMP_PATH: ${dumpBinary}`);
  }

  mkdirSync(backupDir, { recursive: true });
  const stamp = fileTimestamp();
  const filename = `${config.database}_${stamp}.sql`;
  const finalPath = path.join(backupDir, filename);
  const tempPath = `${finalPath}.part`;

  // Không đưa mật khẩu vào argv (sẽ lộ trong Task Manager/Process Explorer).
  const args = [
    `--host=${config.host}`,
    `--port=${config.port}`,
    `--user=${config.user}`,
    "--protocol=TCP",
    "--single-transaction",
    "--quick",
    "--triggers",
    "--hex-blob",
    "--default-character-set=utf8mb4",
    "--no-tablespaces",
    config.database
  ];

  console.log(`→ Đang sao lưu ${config.database} bằng ${dumpBinary} ...`);
  const outFd = openSync(tempPath, "w");
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(dumpBinary, args, {
      env: { ...process.env, MYSQL_PWD: config.password },
      stdio: ["ignore", outFd, "pipe"],
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60 * 60 * 1000
    });
  } finally {
    closeSync(outFd);
  }

  if (result.error) {
    removeQuietly(tempPath);
    throw new Error(`Không chạy được mysqldump: ${result.error.message}`);
  }
  if (result.status !== 0) {
    removeQuietly(tempPath);
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim().slice(0, 1000)
      : String(result.stderr ?? "").trim().slice(0, 1000);
    throw new Error(`mysqldump thoát với mã ${result.status}. ${stderr}`);
  }

  try {
    assertDumpLooksValid(tempPath, config.database);
    renameSync(tempPath, finalPath);
  } catch (error) {
    removeQuietly(tempPath);
    throw error;
  }

  const checksum = await sha256File(finalPath);
  writeFileSync(
    `${finalPath}.sha256`,
    `${checksum}  ${filename}\n`,
    { encoding: "utf8" }
  );
  const sizeMb = (statSync(finalPath).size / (1024 * 1024)).toFixed(2);
  console.log(`✓ Đã tạo ${finalPath} (${sizeMb} MB)`);
  console.log(`  SHA-256: ${checksum}`);

  const removed = applyRetention(backupDir, config.database, keep);
  if (removed.length > 0) {
    console.log(`  Đã xóa ${removed.length} bản sao lưu cũ (giữ ${keep} bản mới nhất).`);
  }
}

main().catch((error) => {
  console.error("✗ Sao lưu thất bại:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
