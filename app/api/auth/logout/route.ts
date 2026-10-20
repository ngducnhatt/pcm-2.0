import type { NextRequest } from "next/server";
import { assertTrustedOrigin } from "@/lib/auth/guard";
import {
  buildClearedSessionCookie,
  getSessionTokenFromRequest,
  revokeSessionByToken
} from "@/lib/auth/session";
import { getRequestContext } from "@/lib/http/request";
import { handleApiError, ok } from "@/lib/http/response";
import { writeAuditStandalone } from "@/lib/services/audit";
import { resolveSession } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const token = getSessionTokenFromRequest(request);
    if (token) {
      const user = await resolveSession(token).catch(() => null);
      await revokeSessionByToken(token);
      if (user) {
        const meta = getRequestContext(request);
        await writeAuditStandalone(
          { id: user.id, fullName: user.fullName },
          {
            action: "AUTH_LOGOUT",
            entityType: "USER",
            entityId: user.id,
            ip: meta.ip,
            userAgent: meta.userAgent
          }
        ).catch(() => undefined);
      }
    }
    const response = ok({ loggedOut: true });
    response.cookies.set(buildClearedSessionCookie());
    return response;
  } catch (error) {
    return handleApiError(error, { request });
  }
}
