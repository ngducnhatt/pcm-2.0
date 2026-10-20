import type { NextRequest } from "next/server";
import { assertTrustedOrigin, requireRole, requireUser } from "@/lib/auth/guard";
import { readJsonBody } from "@/lib/http/body";
import { handleApiError, ok } from "@/lib/http/response";
import {
  getCustomer,
  updateCustomer,
  updateCustomerSchema
} from "@/lib/services/customers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const user = await requireUser(request);
    requireRole(user, ["ADMIN", "SALES"]);
    const { id } = await context.params;
    return ok(await getCustomer(id));
  } catch (error) {
    return handleApiError(error, { request });
  }
}

export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const user = await requireUser(request);
    requireRole(user, ["ADMIN", "SALES"]);
    const { id } = await context.params;
    const input = await readJsonBody(request, updateCustomerSchema, 32 * 1024);
    return ok(await updateCustomer(request, user, id, input));
  } catch (error) {
    return handleApiError(error, { request });
  }
}
