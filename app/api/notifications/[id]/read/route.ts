import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { assertTrustedOrigin, requireUser } from "@/lib/auth/guard";
import { handleApiError, ok } from "@/lib/http/response";
import { NotFoundError } from "@/lib/errors";
import { parsePositiveInt } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    if (!parsePositiveInt(id)) throw new NotFoundError("Không tìm thấy thông báo.");
    const result = await getDb()
      .prepare(
        "UPDATE notifications SET read_at = COALESCE(read_at, UTC_TIMESTAMP(3)) WHERE id = ? AND user_id = ?"
      )
      .bind(id, user.id)
      .run();
    if (result.changes !== 1) throw new NotFoundError("Không tìm thấy thông báo.");
    return ok({ read: true });
  } catch (error) {
    return handleApiError(error, { request });
  }
}
