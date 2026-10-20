import type { NextRequest } from "next/server";
import type { z } from "zod";
import { PayloadTooLargeError, ValidationError } from "@/lib/errors";
import { zodIssueDetails } from "@/lib/validation";

export async function readJsonBody<S extends z.ZodTypeAny>(
  request: NextRequest,
  schema: S,
  maxBytes = 256 * 1024
): Promise<z.output<S>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("application/json")) {
    throw new ValidationError("Content-Type phải là application/json.");
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new ValidationError("Content-Length không hợp lệ.");
    }
    if (contentLength > maxBytes) throw new PayloadTooLargeError(maxBytes);
  }

  if (!request.body) {
    throw new ValidationError("Request phải có body JSON.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PayloadTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) throw new ValidationError("Body JSON không được rỗng.");

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ValidationError("JSON không hợp lệ.");
  }

  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ValidationError("Dữ liệu không hợp lệ.", zodIssueDetails(parsed.error));
  }
  return parsed.data;
}

export function parseQuery<S extends z.ZodTypeAny>(
  request: NextRequest,
  schema: S
): z.output<S> {
  const raw: Record<string, string> = {};
  for (const [key, value] of request.nextUrl.searchParams.entries()) {
    if (!(key in raw)) raw[key] = value;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("Tham số truy vấn không hợp lệ.", zodIssueDetails(parsed.error));
  }
  return parsed.data;
}
