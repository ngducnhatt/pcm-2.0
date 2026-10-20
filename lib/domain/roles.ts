export const ROLES = [
  "ADMIN",
  "SALES",
  "WAREHOUSE",
  "TECHNICIAN",
  "WARRANTY",
  "SHIPPING_MANAGER",
  "SHIPPER",
  "ACCOUNTANT"
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Quản trị hệ thống",
  SALES: "Kinh doanh",
  WAREHOUSE: "Kho",
  TECHNICIAN: "Kỹ thuật",
  WARRANTY: "Bảo hành",
  SHIPPING_MANAGER: "Quản lý giao hàng",
  SHIPPER: "Shipper",
  ACCOUNTANT: "Kế toán / Thanh toán"
};

export const DEPARTMENTS = [
  "SALES",
  "WAREHOUSE",
  "TECHNICAL",
  "WARRANTY",
  "DELIVERY",
  "PAYMENT"
] as const;

export type Department = (typeof DEPARTMENTS)[number];

export const DEPARTMENT_LABELS: Record<Department, string> = {
  SALES: "Kinh doanh",
  WAREHOUSE: "Kho",
  TECHNICAL: "Kỹ thuật",
  WARRANTY: "Bảo hành",
  DELIVERY: "Giao hàng",
  PAYMENT: "Thanh toán"
};

export const DEPARTMENT_QUEUE_SLUGS = {
  SALES: "sales",
  WAREHOUSE: "warehouse",
  TECHNICAL: "technical",
  WARRANTY: "warranty",
  DELIVERY: "delivery",
  PAYMENT: "payment"
} as const;

export type QueueSlug = (typeof DEPARTMENT_QUEUE_SLUGS)[Department];

export const QUEUE_TO_DEPARTMENT: Record<QueueSlug, Department> = {
  sales: "SALES",
  warehouse: "WAREHOUSE",
  technical: "TECHNICAL",
  warranty: "WARRANTY",
  delivery: "DELIVERY",
  payment: "PAYMENT"
};

export const DEPARTMENT_ROLES: Record<Department, Role[]> = {
  SALES: ["SALES"],
  WAREHOUSE: ["WAREHOUSE"],
  TECHNICAL: ["TECHNICIAN"],
  WARRANTY: ["WARRANTY"],
  DELIVERY: ["SHIPPING_MANAGER", "SHIPPER"],
  PAYMENT: ["ACCOUNTANT"]
};

export const ROLE_DEPARTMENT: Partial<Record<Role, Department>> = {
  SALES: "SALES",
  WAREHOUSE: "WAREHOUSE",
  TECHNICIAN: "TECHNICAL",
  WARRANTY: "WARRANTY",
  SHIPPING_MANAGER: "DELIVERY",
  SHIPPER: "DELIVERY",
  ACCOUNTANT: "PAYMENT"
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isDepartment(value: string): value is Department {
  return (DEPARTMENTS as readonly string[]).includes(value);
}

export function departmentForRole(role: Role): Department | null {
  return ROLE_DEPARTMENT[role] ?? null;
}

export function roleCanAccessQueue(role: Role, department: Department): boolean {
  if (role === "ADMIN") return true;
  return DEPARTMENT_ROLES[department].includes(role);
}

export function actorHasDepartmentRole(role: Role, department: Department): boolean {
  if (role === "ADMIN") return true;
  if (department === "SALES") return role === "SALES";
  if (department === "DELIVERY") {
    return role === "SHIPPING_MANAGER" || role === "SHIPPER";
  }
  return DEPARTMENT_ROLES[department].includes(role);
}
