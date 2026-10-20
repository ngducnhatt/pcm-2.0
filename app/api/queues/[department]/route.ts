import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { parseQuery } from "@/lib/http/body";
import { handleApiError, ok } from "@/lib/http/response";
import { queueQuerySchema } from "@/lib/schemas/orders";
import { getQueue } from "@/lib/services/order-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ department: string }> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { department } = await context.params;
    const query = parseQuery(request, queueQuerySchema);
    const result = await getQueue(department, user, {
      page: query.page,
      limit: query.limit,
      includeDrafts: query.includeDrafts,
      q: query.q,
      sort: query.sort
    });
    return ok(result.orders, {
      department: result.department,
      departmentLabel: result.departmentLabel,
      counts: result.counts,
      page: query.page,
      limit: query.limit,
      total: result.total,
      pages: Math.ceil(result.total / query.limit)
    });
  } catch (error) {
    return handleApiError(error, { request });
  }
}
