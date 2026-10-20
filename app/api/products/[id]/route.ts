import type { NextRequest } from "next/server";
import { assertTrustedOrigin, requireRole, requireUser } from "@/lib/auth/guard";
import { readJsonBody } from "@/lib/http/body";
import { handleApiError, ok } from "@/lib/http/response";
import { getProduct, updateProduct, updateProductSchema } from "@/lib/services/products";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    return ok(await getProduct(user, id));
  } catch (error) {
    return handleApiError(error, { request });
  }
}

export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const user = await requireUser(request);
    requireRole(user, ["ADMIN"]);
    const { id } = await context.params;
    const input = await readJsonBody(request, updateProductSchema, 32 * 1024);
    return ok(await updateProduct(request, user, id, input));
  } catch (error) {
    return handleApiError(error, { request });
  }
}
