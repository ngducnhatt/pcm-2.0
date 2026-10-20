import { NextResponse } from "next/server";
import { AppError, RateLimitError } from "@/lib/errors";
import { isDuplicateKeyError } from "@/lib/db";
import { logger } from "@/lib/logger";

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff"
};

export interface ApiSuccess<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export function ok<T>(data: T, meta?: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json<ApiSuccess<T>>(
    { data, ...(meta ? { meta } : {}) },
    { status, headers: BASE_HEADERS }
  );
}

export function created<T>(data: T, meta?: Record<string, unknown>): NextResponse {
  return ok(data, meta, 201);
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204, headers: BASE_HEADERS });
}

export function fail(
  status: number,
  code: string,
  message: string,
  details?: unknown,
  extraHeaders?: Record<string, string>
): NextResponse {
  return NextResponse.json(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status, headers: { ...BASE_HEADERS, ...(extraHeaders ?? {}) } }
  );
}

export function handleApiError(error: unknown, context?: { request?: Request }): NextResponse {
  if (error instanceof RateLimitError) {
    return fail(429, error.code, error.message, error.details, {
      "Retry-After": String(error.retryAfterSeconds)
    });
  }

  if (error instanceof AppError) {
    if (error.status >= 500) {
      logger.error("API error", { code: error.code, message: error.message });
    }
    return fail(error.status, error.code, error.message, error.details);
  }

  if (isDuplicateKeyError(error)) {
    return fail(409, "DUPLICATE", "Dữ liệu đã tồn tại (trùng mã hoặc khóa duy nhất).");
  }

  logger.error("Unhandled API exception", {
    message: error instanceof Error ? error.message : String(error),
    path: context?.request ? new URL(context.request.url).pathname : undefined
  });

  return fail(500, "INTERNAL_ERROR", "Có lỗi hệ thống. Vui lòng thử lại hoặc liên hệ quản trị viên.");
}

export function methodNotAllowed(allow: string): NextResponse {
  return fail(405, "METHOD_NOT_ALLOWED", "Phương thức HTTP không được hỗ trợ.", undefined, {
    Allow: allow
  });
}
