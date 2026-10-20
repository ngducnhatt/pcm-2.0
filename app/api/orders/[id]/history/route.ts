import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { parseQuery } from "@/lib/http/body";
import { handleApiError, ok } from "@/lib/http/response";
import { historyQuerySchema } from "@/lib/schemas/orders";
import { getOrderHistory } from "@/lib/services/order-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const query = parseQuery(request, historyQuerySchema);
    const result = await getOrderHistory(id, user, query.page, query.limit);
    return ok(result.history, {
      page: query.page,
      limit: query.limit,
      total: result.total,
      pages: Math.ceil(result.total / query.limit)
    });
  } catch (error) {
    return handleApiError(error, { request });
  }
}
