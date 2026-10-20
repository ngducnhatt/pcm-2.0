/**
 * Tiền được xử lý bằng BigInt "cents" để tránh sai số dấu phẩy động.
 * API trả chuỗi thập phân (ví dụ "15000000.00") để frontend không mất chính xác.
 */

const MONEY_RE = /^\d{1,15}(\.\d{1,2})?$/;
const MAX_CENTS = 10_000_000_000_000_00n; // 10^16 cents = 10^14 đơn vị tiền

export function moneyToCents(value: string | number): bigint {
  const normalized =
    typeof value === "number"
      ? Number.isFinite(value)
        ? value.toString()
        : ""
      : value.trim();
  if (!MONEY_RE.test(normalized)) {
    throw new Error("Số tiền không hợp lệ (tối đa 2 chữ số thập phân).");
  }
  const [integerPart, fractionPart = ""] = normalized.split(".");
  const cents = BigInt(integerPart) * 100n + BigInt(fractionPart.padEnd(2, "0"));
  if (cents > MAX_CENTS) throw new Error("Số tiền vượt giới hạn.");
  return cents;
}

export function centsToMoney(cents: bigint): string {
  if (cents < 0n) throw new Error("Số tiền không được âm.");
  const integer = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${integer.toString()}.${fraction}`;
}

export interface OrderTotals {
  subtotal: bigint;
  discount: bigint;
  shippingFee: bigint;
  total: bigint;
}

export function calculateOrderTotals(
  lines: Array<{ quantity: number; unitPriceCents: bigint }>,
  discountCents: bigint,
  shippingFeeCents: bigint
): OrderTotals {
  if (!Number.isInteger(lines.length) || lines.some((line) => !Number.isInteger(line.quantity) || line.quantity <= 0)) {
    throw new Error("Số lượng sản phẩm không hợp lệ.");
  }
  if (lines.length === 0) throw new Error("Đơn hàng phải có ít nhất một dòng hàng.");
  if (discountCents < 0n || shippingFeeCents < 0n) {
    throw new Error("Giảm giá và phí giao hàng không được âm.");
  }
  let subtotal = 0n;
  for (const line of lines) {
    if (line.unitPriceCents < 0n) throw new Error("Đơn giá không được âm.");
    subtotal += line.unitPriceCents * BigInt(line.quantity);
  }
  if (discountCents > subtotal) throw new Error("Giảm giá không được lớn hơn tạm tính.");
  const total = subtotal - discountCents + shippingFeeCents;
  return {
    subtotal,
    discount: discountCents,
    shippingFee: shippingFeeCents,
    total
  };
}

export function subtractMoney(minuend: string, subtrahend: string): string {
  const result = moneyToCents(minuend) - moneyToCents(subtrahend);
  return centsToMoney(result < 0n ? 0n : result);
}

export function moneyIsZero(value: string): boolean {
  return value === "0.00" || value === "0" || /^0+\.0+$/.test(value);
}
