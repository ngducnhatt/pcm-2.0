import type { NextRequest } from "next/server";
import { assertTrustedOrigin, requireUser } from "@/lib/auth/guard";
import { readJsonBody } from "@/lib/http/body";
import { handleApiError, ok } from "@/lib/http/response";
import { updateOrderSchema } from "@/lib/schemas/orders";
import { getOrderDetail } from "@/lib/services/order-queries";
import { updateOrder } from "@/lib/services/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    return ok(await getOrderDetail(id, user));
  } catch (error) {
    return handleApiError(error, { request });
  }
}

export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    const input = await readJsonBody(request, updateOrderSchema, 512 * 1024);
    return ok(await updateOrder(request, user, id, input));
  } catch (error) {
    return handleApiError(error, { request });
  }
}
