import { z } from "zod";
import type { NextRequest } from "next/server";
import { getDb, isDuplicateKeyError, withTransaction } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/session";
import { hashPassword, checkPasswordPolicy } from "@/lib/auth/password";
import { revokeUserSessionsTx } from "@/lib/auth/session";
import { ROLES } from "@/lib/domain/roles";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { serializeUser } from "@/lib/services/order-serializer";
import { writeAudit } from "@/lib/services/audit";
import { emailSchema, passwordLoginSchema, roleSchema, usernameSchema } from "@/lib/validation";
import { getRequestContext } from "@/lib/http/request";
import { parsePositiveInt } from "@/lib/utils";

const passwordSchema = passwordLoginSchema.superRefine((value, ctx) => {
  const result = checkPasswordPolicy(value);
  if (!result.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message ?? "Mật khẩu yếu." });
  }
});

export const createUserSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  fullName: z.string().trim().min(2).max(120),
  password: passwordSchema,
  role: roleSchema
});

export const updateUserSchema = z
  .object({
    email: emailSchema.optional(),
    fullName: z.string().trim().min(2).max(120).optional(),
    role: roleSchema.optional(),
    isActive: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, "Không có dữ liệu cập nhật.");

export const resetPasswordSchema = z.object({
  newPassword: passwordSchema
});

export const userListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(ROLES).optional(),
  active: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export async function listUsers(input: z.infer<typeof userListQuerySchema>): Promise<{
  users: Record<string, unknown>[];
  total: number;
}> {
  const db = getDb();
  const where: string[] = ["1 = 1"];
  const params: Array<string | number> = [];
  if (input.q) {
    const term = `%${input.q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push(
      "(username LIKE ? ESCAPE '\\\\' OR email LIKE ? ESCAPE '\\\\' OR full_name LIKE ? ESCAPE '\\\\')"
    );
    params.push(term, term, term);
  }
  if (input.role) {
    where.push("role = ?");
    params.push(input.role);
  }
  if (input.active) {
    where.push("is_active = ?");
    params.push(input.active === "true" ? 1 : 0);
  }
  const whereSql = where.join(" AND ");
  const totalRow = await db
    .prepare<{ total: number | string }>(`SELECT COUNT(*) AS total FROM users WHERE ${whereSql}`)
    .bind(...params)
    .first();
  const rows = await db
    .prepare<{
      id: string;
      username: string;
      email: string;
      full_name: string;
      role: string;
      is_active: number;
      last_login_at: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, username, email, full_name, role, is_active, last_login_at, created_at, updated_at
       FROM users WHERE ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...params, input.limit, (input.page - 1) * input.limit)
    .all();
  return {
    users: rows.map(serializeUser),
    total: Number(totalRow?.total ?? 0)
  };
}

export async function createUser(
  request: NextRequest,
  admin: SessionUser,
  input: z.infer<typeof createUserSchema>
): Promise<Record<string, unknown>> {
  const meta = getRequestContext(request);
  const passwordHash = await hashPassword(input.password);
  try {
    const userId = await withTransaction(async (query) => {
      const result = await query
        .prepare(
          `INSERT INTO users
             (username, email, full_name, password_hash, role, is_active, created_by,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
        )
        .bind(input.username, input.email, input.fullName, passwordHash, input.role, admin.id)
        .run();
      const id = String(result.lastInsertId);
      await writeAudit(query, { id: admin.id, fullName: admin.fullName }, {
        action: "USER_CREATED",
        entityType: "USER",
        entityId: id,
        after: {
          username: input.username,
          email: input.email,
          fullName: input.fullName,
          role: input.role,
          isActive: true
        },
        ip: meta.ip,
        userAgent: meta.userAgent
      });
      return id;
    });
    return getUserById(userId);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new ConflictError("Tên đăng nhập hoặc email đã tồn tại.");
    }
    throw error;
  }
}

export async function getUserById(userId: string): Promise<Record<string, unknown>> {
  if (!parsePositiveInt(userId)) throw new NotFoundError("Không tìm thấy người dùng.");
  const row = await getDb()
    .prepare<{
      id: string;
      username: string;
      email: string;
      full_name: string;
      role: string;
      is_active: number;
      last_login_at: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, username, email, full_name, role, is_active, last_login_at, created_at, updated_at
       FROM users WHERE id = ? LIMIT 1`
    )
    .bind(userId)
    .first();
  if (!row) throw new NotFoundError("Không tìm thấy người dùng.");
  return serializeUser(row);
}

export async function updateUser(
  request: NextRequest,
  admin: SessionUser,
  userId: string,
  input: z.infer<typeof updateUserSchema>
): Promise<Record<string, unknown>> {
  if (admin.id === userId && (input.isActive === false || (input.role && input.role !== "ADMIN"))) {
    throw new ForbiddenError("Bạn không thể tự khóa hoặc tự bỏ quyền admin của chính mình.");
  }
  const meta = getRequestContext(request);
  try {
    await withTransaction(async (query) => {
      const current = await query
        .prepare<{
          id: string;
          username: string;
          email: string;
          full_name: string;
          role: string;
          is_active: number;
        }>("SELECT id, username, email, full_name, role, is_active FROM users WHERE id = ? FOR UPDATE")
        .bind(userId)
        .first();
      if (!current) throw new NotFoundError("Không tìm thấy người dùng.");

      const willRemainAdmin =
        (input.role ?? current.role) === "ADMIN" &&
        (input.isActive === undefined ? Boolean(current.is_active) : input.isActive);
      if (current.role === "ADMIN" && Number(current.is_active) === 1 && !willRemainAdmin) {
        const admins = await query
          .prepare<{ id: string }>(
            "SELECT id FROM users WHERE role = 'ADMIN' AND is_active = 1 FOR UPDATE"
          )
          .bind()
          .all();
        if (admins.length <= 1) {
          throw new ConflictError("Không thể khóa/hạ quyền admin cuối cùng của hệ thống.");
        }
      }

      const fields: string[] = [];
      const params: Array<string | number> = [];
      if (input.email !== undefined) {
        fields.push("email = ?");
        params.push(input.email);
      }
      if (input.fullName !== undefined) {
        fields.push("full_name = ?");
        params.push(input.fullName);
      }
      if (input.role !== undefined) {
        fields.push("role = ?");
        params.push(input.role);
        if (input.role !== current.role) {
          // Vai trò đổi ngay lập tức; thu hồi phiên cũ để tránh cache quyền ở client.
          await revokeUserSessionsTx(query, userId);
        }
      }
      if (input.isActive !== undefined) {
        fields.push("is_active = ?");
        params.push(input.isActive ? 1 : 0);
        if (!input.isActive) await revokeUserSessionsTx(query, userId);
      }
      if (fields.length === 0) return;
      fields.push("updated_at = UTC_TIMESTAMP(3)");
      params.push(userId);
      await query
        .prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`)
        .bind(...params)
        .run();
      await writeAudit(query, { id: admin.id, fullName: admin.fullName }, {
        action: "USER_UPDATED",
        entityType: "USER",
        entityId: userId,
        before: {
          email: current.email,
          fullName: current.full_name,
          role: current.role,
          isActive: Boolean(current.is_active)
        },
        after: {
          email: input.email ?? current.email,
          fullName: input.fullName ?? current.full_name,
          role: input.role ?? current.role,
          isActive: input.isActive ?? Boolean(current.is_active)
        },
        ip: meta.ip,
        userAgent: meta.userAgent
      });
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new ConflictError("Email đã tồn tại.");
    throw error;
  }
  return getUserById(userId);
}

export async function resetUserPassword(
  request: NextRequest,
  admin: SessionUser,
  userId: string,
  newPassword: string
): Promise<void> {
  const meta = getRequestContext(request);
  const passwordHash = await hashPassword(newPassword);
  await withTransaction(async (query) => {
    const target = await query
      .prepare<{ id: string; username: string }>(
        "SELECT id, username FROM users WHERE id = ? FOR UPDATE"
      )
      .bind(userId)
      .first();
    if (!target) throw new NotFoundError("Không tìm thấy người dùng.");
    await query
      .prepare(
        `UPDATE users SET password_hash = ?, password_changed_at = UTC_TIMESTAMP(3),
           failed_login_attempts = 0, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
         WHERE id = ?`
      )
      .bind(passwordHash, userId)
      .run();
    await revokeUserSessionsTx(query, userId);
    await writeAudit(query, { id: admin.id, fullName: admin.fullName }, {
      action: "USER_PASSWORD_RESET",
      entityType: "USER",
      entityId: userId,
      metadata: { username: target.username },
      ip: meta.ip,
      userAgent: meta.userAgent
    });
  });
}
