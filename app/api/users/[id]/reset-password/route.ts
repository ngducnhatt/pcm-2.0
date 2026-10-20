import type { NextRequest } from "next/server";
import { assertTrustedOrigin, requireRole, requireUser } from "@/lib/auth/guard";
import { readJsonBody } from "@/lib/http/body";
import { handleApiError, ok } from "@/lib/http/response";
import { resetPasswordSchema, resetUserPassword } from "@/lib/services/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const admin = await requireUser(request);
    requireRole(admin, ["ADMIN"]);
    const { id } = await context.params;
    const input = await readJsonBody(request, resetPasswordSchema, 16 * 1024);
    await resetUserPassword(request, admin, id, input.newPassword);
    return ok({ reset: true });
  } catch (error) {
    return handleApiError(error, { request });
  }
}
