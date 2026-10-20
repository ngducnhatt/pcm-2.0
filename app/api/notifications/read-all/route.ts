import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { assertTrustedOrigin, requireUser } from "@/lib/auth/guard";
import { handleApiError, ok } from "@/lib/http/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const user = await requireUser(request);
    const result = await getDb()
      .prepare(
        "UPDATE notifications SET read_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND read_at IS NULL"
      )
      .bind(user.id)
      .run();
    return ok({ read: result.changes });
  } catch (error) {
    return handleApiError(error, { request });
  }
}
