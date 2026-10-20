import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/auth/guard";
import { parseQuery } from "@/lib/http/body";
import { handleApiError, ok } from "@/lib/http/response";
import { toIsoOrNull } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  unread: z.enum(["true", "false"]).default("false"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const user = await requireUser(request);
    const query = parseQuery(request, querySchema);
    const db = getDb();
    const where = query.unread === "true"
      ? "user_id = ? AND read_at IS NULL"
      : "user_id = ?";
    const total = await db
      .prepare<{ total: number | string }>(`SELECT COUNT(*) AS total FROM notifications WHERE ${where}`)
      .bind(user.id)
      .first();
    const rows = await db
      .prepare<{
        id: string;
        type: string;
        title: string;
        body: string;
        order_id: string | null;
        read_at: string | null;
        created_at: string;
      }>(
        `SELECT id, type, title, body, order_id, read_at, created_at
         FROM notifications WHERE ${where}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .bind(user.id, query.limit, (query.page - 1) * query.limit)
      .all();
    const unread = await db
      .prepare<{ total: number | string }>(
        "SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND read_at IS NULL"
      )
      .bind(user.id)
      .first();
    return ok(
      rows.map((row) => ({
        id: String(row.id),
        type: row.type,
        title: row.title,
        body: row.body,
        orderId: row.order_id ? String(row.order_id) : null,
        readAt: toIsoOrNull(row.read_at),
        createdAt: toIsoOrNull(row.created_at)
      })),
      {
        page: query.page,
        limit: query.limit,
        total: Number(total?.total ?? 0),
        pages: Math.ceil(Number(total?.total ?? 0) / query.limit),
        unread: Number(unread?.total ?? 0)
      }
    );
  } catch (error) {
    return handleApiError(error, { request });
  }
}
