const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;
const PREFIX = "pbkdf2-sha256";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function getSubtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto không khả dụng. Yêu cầu Node.js 22+.");
  }
  return globalThis.crypto.subtle;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await getSubtle().importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await getSubtle().deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash: "SHA-256"
    },
    keyMaterial,
    HASH_BITS
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `${PREFIX}$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const parts = storedHash.split("$");
    if (parts.length !== 4 || parts[0] !== PREFIX) return false;
    const iterations = Number.parseInt(parts[1], 10);
    if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 2_000_000) {
      return false;
    }
    const salt = fromBase64(parts[2]);
    const expected = fromBase64(parts[3]);
    if (salt.length < 8 || expected.length !== 32) return false;
    const actual = await derive(password, salt, iterations);
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Tiêu tốn thời gian tương đương khi username không tồn tại (giảm timing oracle). */
export async function burnPasswordTime(password: string): Promise<void> {
  const salt = new Uint8Array(SALT_BYTES);
  for (let i = 0; i < salt.length; i += 1) salt[i] = i + 1;
  await derive(password, salt, PBKDF2_ITERATIONS);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export interface PasswordPolicyResult {
  ok: boolean;
  message?: string;
}

/**
 * Chính sách mật khẩu cho tài khoản nội bộ: tối thiểu 12 ký tự và có ít
 * nhất 3 trong 4 nhóm ký tự. Không áp dụng chính sách này cho mật khẩu đăng
 * nhập cũ (tránh khóa người dùng ngoài ý muốn).
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < 12) {
    return { ok: false, message: "Mật khẩu phải có ít nhất 12 ký tự." };
  }
  if (password.length > 200) {
    return { ok: false, message: "Mật khẩu tối đa 200 ký tự." };
  }
  const groups = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password)
  ].filter(Boolean).length;
  if (groups < 3) {
    return {
      ok: false,
      message: "Mật khẩu phải có ít nhất 3 nhóm: chữ thường, chữ hoa, số, ký tự đặc biệt."
    };
  }
  return { ok: true };
}
