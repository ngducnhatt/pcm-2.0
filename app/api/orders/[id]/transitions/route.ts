import type { NextRequest } from "next/server";
import { assertTrustedOrigin, requireUser } from "@/lib/auth/guard";
import { readJsonBody } from "@/lib/http/body";
import { handleApiError, ok } from "@/lib/http/response";
import { orderTransitionSchema } from "@/lib/schemas/orders";
import { transitionOrder } from "@/lib/services/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    const input = await readJsonBody(request, orderTransitionSchema, 128 * 1024);
    const order = await transitionOrder(request, user, id, input);
    return ok(order);
  } catch (error) {
    return handleApiError(error, { request });
  }
}
