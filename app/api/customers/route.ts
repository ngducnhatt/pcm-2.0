import type { NextRequest } from "next/server";
import { assertTrustedOrigin, requireRole, requireUser } from "@/lib/auth/guard";
import { parseQuery, readJsonBody } from "@/lib/http/body";
import { created, handleApiError, ok } from "@/lib/http/response";
import {
  createCustomer,
  createCustomerSchema,
  customerListQuerySchema,
  listCustomers
} from "@/lib/services/customers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const user = await requireUser(request);
    requireRole(user, ["ADMIN", "SALES"]);
    const query = parseQuery(request, customerListQuerySchema);
    const result = await listCustomers(query);
    return ok(result.customers, {
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
    requireRole(user, ["ADMIN", "SALES"]);
    const input = await readJsonBody(request, createCustomerSchema, 32 * 1024);
    return created(await createCustomer(request, user, input));
  } catch (error) {
    return handleApiError(error, { request });
  }
}
