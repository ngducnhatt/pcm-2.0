import { getDb, type DbExecutor } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/session";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | number | null;
  orderId?: string | number | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

function auditJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    const serialized = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      return item;
    });
    return serialized.length > 64_000 ? serialized.slice(0, 64_000) : serialized;
  } catch {
    return null;
  }
}

export async function writeAudit(
  query: DbExecutor,
  actor: Pick<SessionUser, "id" | "fullName"> | null,
  entry: AuditEntry
): Promise<void> {
  await query
    .prepare(
      `INSERT INTO audit_logs
        (actor_id, actor_name, action, entity_type, entity_id, order_id,
         before_data, after_data, metadata, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`
    )
    .bind(
      actor?.id ?? null,
      actor?.fullName ?? null,
      entry.action,
      entry.entityType,
      entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
      entry.orderId ?? null,
      auditJson(entry.before),
      auditJson(entry.after),
      auditJson(entry.metadata),
      entry.ip ?? null,
      entry.userAgent ? entry.userAgent.slice(0, 512) : null
    )
    .run();
}

export async function writeAuditStandalone(
  actor: Pick<SessionUser, "id" | "fullName"> | null,
  entry: AuditEntry
): Promise<void> {
  await writeAudit(getDb(), actor, entry);
}
