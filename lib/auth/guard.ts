import type { NextRequest } from "next/server";
import type { Role } from "@/lib/domain/roles";
import { ForbiddenError } from "@/lib/errors";
import { getPublicUrl } from "@/lib/env";
import { authenticateRequest, type SessionUser } from "@/lib/auth/session";

export async function requireUser(request: NextRequest): Promise<SessionUser> {
  return authenticateRequest(request);
}

export function requireRole(user: SessionUser, roles: Role[]): void {
  if (!roles.includes(user.role)) {
    throw new ForbiddenError();
  }
}

export function requirePermission(user: SessionUser, allowed: boolean): void {
  if (!allowed) throw new ForbiddenError();
}

/**
 * Kiểm tra Origin/Referer cho request làm thay đổi dữ liệu.
 * SameSite=Lax đã chặn phần lớn CSRF; kiểm tra này là lớp phòng thủ thứ hai.
 * Request không có Origin (curl, script nội bộ) vẫn được phép vì không mang
 * cookie trình duyệt tự động. Khi có Origin, origin phải khớp Host công khai.
 */
export function assertTrustedOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    throw new ForbiddenError("Yêu cầu cross-site bị từ chối.");
  }
  if (!origin) return;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new ForbiddenError("Origin không hợp lệ.");
  }

  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    request.nextUrl.host;
  const protocol =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    request.nextUrl.protocol.replace(":", "") ||
    "http";
  const expectedOrigin = `${protocol}://${host}`;
  const allowed = new Set<string>([expectedOrigin, request.nextUrl.origin]);
  const publicUrl = getPublicUrl();
  if (publicUrl) allowed.add(publicUrl);
  if (process.env.NODE_ENV !== "production") {
    allowed.add("http://127.0.0.1:3000");
    allowed.add("http://localhost:3000");
  }

  if (!allowed.has(originUrl.origin)) {
    throw new ForbiddenError("Origin không được phép.");
  }
}
