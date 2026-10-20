import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { handleApiError, ok } from "@/lib/http/response";
import { getDashboard } from "@/lib/services/order-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const user = await requireUser(request);
    return ok(await getDashboard(user));
  } catch (error) {
    return handleApiError(error, { request });
  }
}
