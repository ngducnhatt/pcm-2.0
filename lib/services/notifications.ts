import type { DbExecutor } from "@/lib/db";
import type { Role } from "@/lib/domain/roles";

export interface NotificationInput {
  type: string;
  title: string;
  body: string;
  orderId?: string | number | null;
}

export async function notifyUsers(
  query: DbExecutor,
  userIds: Array<string | number>,
  input: NotificationInput,
  excludeUserId?: string | number
): Promise<void> {
  const unique = [...new Set(userIds.map(String))].filter((id) => id !== String(excludeUserId ?? ""));
  for (const userId of unique) {
    await query
      .prepare(
        `INSERT INTO notifications (user_id, type, title, body, order_id, created_at)
         VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`
      )
      .bind(
        userId,
        input.type.slice(0, 50),
        input.title.slice(0, 200),
        input.body.slice(0, 1000),
        input.orderId ?? null
      )
      .run();
  }
}

export async function notifyRoles(
  query: DbExecutor,
  roles: Role[],
  input: NotificationInput,
  excludeUserId?: string | number
): Promise<void> {
  if (roles.length === 0) return;
  const placeholders = roles.map(() => "?").join(",");
  const rows = await query
    .prepare<{ id: string }>(
      `SELECT id FROM users WHERE is_active = 1 AND role IN (${placeholders})`
    )
    .bind(...roles)
    .all();
  await notifyUsers(
    query,
    rows.map((row) => row.id),
    input,
    excludeUserId
  );
}

export async function notifyOrderWatchers(
  query: DbExecutor,
  orderId: string | number,
  createdById: string | number,
  input: NotificationInput,
  excludeUserId?: string | number
): Promise<void> {
  await notifyUsers(query, [createdById], input, excludeUserId);
}
