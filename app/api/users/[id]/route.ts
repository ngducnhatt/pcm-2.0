import type { NextRequest } from "next/server";
import { assertTrustedOrigin, requireRole, requireUser } from "@/lib/auth/guard";
import { readJsonBody } from "@/lib/http/body";
import { handleApiError, ok } from "@/lib/http/response";
import { getUserById, updateUser, updateUserSchema } from "@/lib/services/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const admin = await requireUser(request);
    requireRole(admin, ["ADMIN"]);
    const { id } = await context.params;
    return ok(await getUserById(id));
  } catch (error) {
    return handleApiError(error, { request });
  }
}

export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const admin = await requireUser(request);
    requireRole(admin, ["ADMIN"]);
    const { id } = await context.params;
    const input = await readJsonBody(request, updateUserSchema, 16 * 1024);
    return ok(await updateUser(request, admin, id, input));
  } catch (error) {
    return handleApiError(error, { request });
  }
}
