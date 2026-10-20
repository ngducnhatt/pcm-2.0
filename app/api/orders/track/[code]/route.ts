import type { NextRequest } from "next/server";
import { parseQuery } from "@/lib/http/body";
import { getClientIp } from "@/lib/http/request";
import { enforceTrackingRateLimit } from "@/lib/http/rate-limit";
import { handleApiError, ok } from "@/lib/http/response";
import { trackingQuerySchema } from "@/lib/schemas/orders";
import { trackOrderPublic } from "@/lib/services/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ code: string }> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const { code } = await context.params;
    const query = parseQuery(request, trackingQuerySchema);
    const ip = getClientIp(request);
    await enforceTrackingRateLimit(ip, code.slice(0, 40));
    const data = await trackOrderPublic(code.slice(0, 40), query.phone);
    return ok(data);
  } catch (error) {
    return handleApiError(error, { request });
  }
}
