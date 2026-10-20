import type { NextRequest } from "next/server";
import { assertTrustedOrigin, requireRole, requireUser } from "@/lib/auth/guard";
import { parseQuery, readJsonBody } from "@/lib/http/body";
import { created, handleApiError, ok } from "@/lib/http/response";
import {
  createUser,
  createUserSchema,
  listUsers,
  userListQuerySchema
} from "@/lib/services/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const user = await requireUser(request);
    requireRole(user, ["ADMIN"]);
    const query = parseQuery(request, userListQuerySchema);
    const result = await listUsers(query);
    return ok(result.users, {
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
    const admin = await requireUser(request);
    requireRole(admin, ["ADMIN"]);
    const input = await readJsonBody(request, createUserSchema, 16 * 1024);
    return created(await createUser(request, admin, input));
  } catch (error) {
    return handleApiError(error, { request });
  }
}
