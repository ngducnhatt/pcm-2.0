import type { NextRequest } from "next/server";
import { assertTrustedOrigin, requireUser } from "@/lib/auth/guard";
import { readJsonBody } from "@/lib/http/body";
import { handleApiError, ok, created } from "@/lib/http/response";
import { parseQuery } from "@/lib/http/body";
import { createOrderSchema, orderListQuerySchema } from "@/lib/schemas/orders";
import { createOrder } from "@/lib/services/orders";
import { listOrders } from "@/lib/services/order-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const user = await requireUser(request);
    const query = parseQuery(request, orderListQuerySchema);
    const result = await listOrders(user, query);
    return ok(result.orders, {
      page: query.page,
      limit: query.limit,
      total: result.total,
      pages: Math.ceil(result.total / query.limit)
    });
  } catch (error) {
    return handleApiError(error, { request });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const user = await requireUser(request);
    const input = await readJsonBody(request, createOrderSchema, 512 * 1024);
    const order = await createOrder(request, user, input);
    return created(order);
  } catch (error) {
    return handleApiError(error, { request });
  }
}
