#!/usr/bin/env node
/**
 * PCM OpsFlow - kiểm tra sức khỏe API từ chính máy chủ.
 * Mặc định chỉ gọi loopback, không gọi domain công khai.
 *
 * Chạy: npm run health
 * Hoặc: node scripts/healthcheck.mjs --url http://127.0.0.1:3000/api/health
 */
import process from "node:process";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ path: ".env", quiet: true });

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const rawUrl = readArg("--url") ?? process.env.HEALTH_URL ?? `http://127.0.0.1:${port}/api/health`;

let url;
try {
  url = new URL(rawUrl);
} catch {
  console.error(`[health] URL không hợp lệ: ${rawUrl}`);
  process.exit(1);
}

const isLoopback =
  url.hostname === "127.0.0.1" ||
  url.hostname === "::1" ||
  url.hostname === "[::1]" ||
  url.hostname === "localhost";
if (!isLoopback && process.env.HEALTH_ALLOW_REMOTE !== "true") {
  console.error(
    "[health] Từ chối gọi URL không phải loopback. Đặt HEALTH_ALLOW_REMOTE=true nếu thật sự cần."
  );
  process.exit(1);
}

const started = Date.now();
try {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { "user-agent": "pcm-opsflow-healthcheck", accept: "application/json" }
  });
  const elapsed = Date.now() - started;
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    console.error(
      `[health] FAIL HTTP ${response.status} sau ${elapsed} ms${
        body?.status ? ` (status=${body.status}, database=${body.database ?? "?"})` : ""
      }`
    );
    process.exit(1);
  }

  const schema = body?.schemaVersion ?? "?";
  console.log(
    `[health] OK HTTP ${response.status} sau ${elapsed} ms (schema=${schema}, dbLatency=${
      body?.dbLatencyMs ?? "?"
    } ms)`
  );
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[health] FAIL không kết nối được ${url}: ${message}`);
  process.exit(1);
}
