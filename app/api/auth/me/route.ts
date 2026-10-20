import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { handleApiError, ok } from "@/lib/http/response";
import { ROLE_LABELS } from "@/lib/domain/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const user = await requireUser(request);
    return ok({
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      roleLabel: ROLE_LABELS[user.role],
      sessionExpiresAt: user.sessionExpiresAt.toISOString()
    });
  } catch (error) {
    return handleApiError(error, { request });
  }
}
