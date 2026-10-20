import type { NextRequest } from "next/server";
import { requireRole, requireUser } from "@/lib/auth/guard";
import { parseQuery } from "@/lib/http/body";
import { handleApiError, ok } from "@/lib/http/response";
import { listProductSerials, serialListQuerySchema } from "@/lib/services/products";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const user = await requireUser(request);
    requireRole(user, ["ADMIN", "SALES", "WAREHOUSE", "TECHNICIAN", "WARRANTY"]);
    const { id } = await context.params;
    const query = parseQuery(request, serialListQuerySchema);
    const result = await listProductSerials(id, query);
    return ok(result.serials, {
      page: query.page,
      limit: query.limit,
      total: result.total,
      pages: Math.ceil(result.total / query.limit)
    });
  } catch (error) {
    return handleApiError(error, { request });
  }
}
