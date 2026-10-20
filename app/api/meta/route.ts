import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { handleApiError, ok } from "@/lib/http/response";
import {
  DEPARTMENT_LABELS,
  ROLE_LABELS,
  ROLES
} from "@/lib/domain/roles";
import {
  DEPARTMENT_STATUSES,
  ORDER_ACTIONS,
  ACTION_LABELS,
  ORDER_STATUSES,
  STATUS_LABELS
} from "@/lib/domain/order-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser(request);
    return ok({
      roles: ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
      departments: Object.entries(DEPARTMENT_LABELS).map(([value, label]) => ({
        value,
        label
      })),
      statuses: ORDER_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
      departmentStatuses: DEPARTMENT_STATUSES,
      actions: ORDER_ACTIONS.map((value) => ({ value, label: ACTION_LABELS[value] }))
    });
  } catch (error) {
    return handleApiError(error, { request });
  }
}
