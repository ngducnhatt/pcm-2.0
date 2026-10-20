import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import { getProxyMode, getTrustProxy } from "@/lib/env";

function validIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let candidate = value.trim();
  if (!candidate || candidate.length > 64) return null;
  if (candidate.includes(",")) candidate = candidate.split(",")[0]!.trim();
  // Bỏ port dạng IPv4:port nếu proxy không chuẩn hóa.
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(":"));
  }
  if (candidate.startsWith("[") && candidate.endsWith("]")) {
    candidate = candidate.slice(1, -1);
  }
  return isIP(candidate) ? candidate : null;
}

export function getClientIp(request: NextRequest): string {
  if (!getTrustProxy()) {
    // App chỉ listen loopback; khi không tin proxy, request hợp lệ đến từ máy chủ.
    return validIp(request.headers.get("x-real-ip")) ?? "127.0.0.1";
  }

  const mode = getProxyMode();
  if (mode !== "caddy") {
    const cf = validIp(request.headers.get("cf-connecting-ip"));
    if (cf) return cf;
  }
  const realIp = validIp(request.headers.get("x-real-ip"));
  if (realIp) return realIp;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    for (const part of forwarded.split(",")) {
      const ip = validIp(part);
      if (ip) return ip;
    }
  }
  return "127.0.0.1";
}

export function getUserAgent(request: NextRequest): string | null {
  return request.headers.get("user-agent")?.slice(0, 512) ?? null;
}

export function getRequestContext(request: NextRequest): {
  ip: string;
  userAgent: string | null;
} {
  return { ip: getClientIp(request), userAgent: getUserAgent(request) };
}
