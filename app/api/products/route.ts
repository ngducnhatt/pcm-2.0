import type { NextRequest } from "next/server";
import { assertTrustedOrigin, requireRole, requireUser } from "@/lib/auth/guard";
import { parseQuery, readJsonBody } from "@/lib/http/body";
import { created, handleApiError, ok } from "@/lib/http/response";
import {
  createProduct,
  createProductSchema,
  listProducts,
  productListQuerySchema
} from "@/lib/services/products";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const user = await requireUser(request);
    const query = parseQuery(request, productListQuerySchema);
    const result = await listProducts(user, query);
    return ok(result.products, {
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
    requireRole(user, ["ADMIN"]);
    const input = await readJsonBody(request, createProductSchema, 32 * 1024);
    return created(await createProduct(request, user, input));
  } catch (error) {
    return handleApiError(error, { request });
  }
}
