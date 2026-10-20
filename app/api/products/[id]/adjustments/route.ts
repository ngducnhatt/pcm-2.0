import type { NextRequest } from "next/server";
import { assertTrustedOrigin, requireRole, requireUser } from "@/lib/auth/guard";
import { readJsonBody } from "@/lib/http/body";
import { handleApiError, ok } from "@/lib/http/response";
import { adjustStock, stockAdjustmentSchema } from "@/lib/services/products";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const user = await requireUser(request);
    requireRole(user, ["ADMIN", "WAREHOUSE"]);
    const { id } = await context.params;
    const input = await readJsonBody(request, stockAdjustmentSchema, 64 * 1024);
    return ok(await adjustStock(request, user, id, input));
  } catch (error) {
    return handleApiError(error, { request });
  }
}
