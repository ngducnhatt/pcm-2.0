import { randomBytes } from "node:crypto";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return result;
}

export function generateOrderCode(now = new Date()): string {
  const yymmdd = now.toISOString().slice(2, 10).replace(/-/g, "");
  return `PCM-${yymmdd}-${randomCode(8)}`;
}

export function generateCustomerCode(now = new Date()): string {
  const yymmdd = now.toISOString().slice(2, 10).replace(/-/g, "");
  return `KH-${yymmdd}-${randomCode(6)}`;
}

export function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return `${normalized}T00:00:00.000Z`;
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseDbDate(value: string | null | undefined): Date | null {
  const iso = toIsoOrNull(value);
  return iso ? new Date(iso) : null;
}

export function dbDateTime(date: Date): string {
  return date.toISOString().slice(0, 23).replace("T", " ");
}

export function parsePositiveInt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function asStringId(value: unknown): string {
  return String(value ?? "");
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value as T;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function todayDateOnly(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addMonthsToDate(date: Date, months: number): string {
  const copy = new Date(date.getTime());
  const originalDay = copy.getUTCDate();
  copy.setUTCMonth(copy.getUTCMonth() + months);
  if (copy.getUTCDate() < originalDay) copy.setUTCDate(0);
  return copy.toISOString().slice(0, 10);
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
