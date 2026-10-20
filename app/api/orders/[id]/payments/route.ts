import type { NextRequest } from "next/server";
import { assertTrustedOrigin, requireUser } from "@/lib/auth/guard";
import { readJsonBody } from "@/lib/http/body";
import { handleApiError, created } from "@/lib/http/response";
import { recordPaymentSchema } from "@/lib/schemas/orders";
import { recordPayment } from "@/lib/services/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    const input = await readJsonBody(request, recordPaymentSchema, 32 * 1024);
    const result = await recordPayment(request, user, id, input);
    return created(result.order, { duplicate: result.duplicate });
  } catch (error) {
    return handleApiError(error, { request });
  }
}
