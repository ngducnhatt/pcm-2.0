import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireRole, requireUser } from "@/lib/auth/guard";
import { parseQuery } from "@/lib/http/body";
import { handleApiError, ok } from "@/lib/http/response";
import { dateOnlySchema, idSchema } from "@/lib/validation";
import { safeJsonParse, toIsoOrNull } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(50).optional(),
  actorId: idSchema.optional(),
  orderId: idSchema.optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const user = await requireUser(request);
    requireRole(user, ["ADMIN"]);
    const query = parseQuery(request, querySchema);
    const db = getDb();
    const where: string[] = ["1 = 1"];
    const params: Array<string | number> = [];
    if (query.action) {
      where.push("action = ?");
      params.push(query.action);
    }
    if (query.entityType) {
      where.push("entity_type = ?");
      params.push(query.entityType);
    }
    if (query.actorId) {
      where.push("actor_id = ?");
      params.push(query.actorId);
    }
    if (query.orderId) {
      where.push("order_id = ?");
      params.push(query.orderId);
    }
    if (query.from) {
      where.push("created_at >= ?");
      params.push(`${query.from} 00:00:00.000`);
    }
    if (query.to) {
      where.push("created_at < DATE_ADD(?, INTERVAL 1 DAY)");
      params.push(`${query.to} 00:00:00.000`);
    }
    const whereSql = where.join(" AND ");
    const total = await db
      .prepare<{ total: number | string }>(
        `SELECT COUNT(*) AS total FROM audit_logs WHERE ${whereSql}`
      )
      .bind(...params)
      .first();
    const rows = await db
      .prepare<{
        id: string;
        actor_id: string | null;
        actor_name: string | null;
        action: string;
        entity_type: string;
        entity_id: string | null;
        order_id: string | null;
        before_data: unknown;
        after_data: unknown;
        metadata: unknown;
        ip: string | null;
        user_agent: string | null;
        created_at: string;
      }>(
        `SELECT id, actor_id, actor_name, action, entity_type, entity_id, order_id,
                before_data, after_data, metadata, ip, user_agent, created_at
         FROM audit_logs WHERE ${whereSql}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .bind(...params, query.limit, (query.page - 1) * query.limit)
      .all();
    return ok(
      rows.map((row) => ({
        id: String(row.id),
        actor: row.actor_name
          ? { id: row.actor_id, fullName: row.actor_name }
          : null,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        orderId: row.order_id ? String(row.order_id) : null,
        before: safeJsonParse<unknown>(row.before_data, null),
        after: safeJsonParse<unknown>(row.after_data, null),
        metadata: safeJsonParse<unknown>(row.metadata, null),
        ip: row.ip,
        userAgent: row.user_agent,
        createdAt: toIsoOrNull(row.created_at)
      })),
      {
        page: query.page,
        limit: query.limit,
        total: Number(total?.total ?? 0),
        pages: Math.ceil(Number(total?.total ?? 0) / query.limit)
      }
    );
  } catch (error) {
    return handleApiError(error, { request });
  }
}
