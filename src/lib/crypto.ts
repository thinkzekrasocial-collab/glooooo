/**
 * Server-side cryptography helpers.
 *
 * Production (TRD §3.2): argon2id via WASM in the Worker, jose for JWT, otplib
 * for TOTP. In this sandbox we use Node's audited primitives:
 *   - password hashing : scrypt (N=16384, r=8, p=1) + 16-byte salt, constant-time compare
 *   - token hashing    : SHA-256
 *   - secret at rest   : AES-256-GCM (TOTP seeds, push keys)
 *   - TOTP             : RFC 6238 HMAC-SHA1, 6 digits, 30s step, ±1 window
 * No custom ciphers or KDF constructions are introduced.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import bcrypt from "bcryptjs";

/* ─────────────────────────── tokens & hashes ─────────────────────────── */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha1(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha1", key).update(data).digest();
}

/* ─────────────────────────── passwords ─────────────────────────── */

const BCRYPT_COST = 12;
const LEGACY_SCRYPT_N = 16384;
const LEGACY_SCRYPT_R = 8;
const LEGACY_SCRYPT_P = 1;
const LEGACY_KEY_LEN = 64;

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password.normalize("NFKC"), BCRYPT_COST);
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    if (stored.startsWith("$2")) return bcrypt.compareSync(password.normalize("NFKC"), stored);
    // One-way compatibility path for existing records; callers must immediately rehash.
    const [scheme, n, r, p, saltB64, hashB64] = stored.split("$");
    if (scheme !== "scrypt" || Number(n) !== LEGACY_SCRYPT_N || Number(r) !== LEGACY_SCRYPT_R || Number(p) !== LEGACY_SCRYPT_P) return false;
    const derived = scryptSync(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), LEGACY_KEY_LEN, { N: LEGACY_SCRYPT_N, r: LEGACY_SCRYPT_R, p: LEGACY_SCRYPT_P, maxmem: 128 * 1024 * 1024 });
    const expected = Buffer.from(hashB64, "base64");
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function needsPasswordRehash(stored: string): boolean {
  return !stored.startsWith("$2b$") || !stored.startsWith(`$2b$${BCRYPT_COST}$`);
}

/**
 * Generates a temporary password that always satisfies passwordIssues()
 * (upper + lower + digit + symbol) for admin-issued credentials.
 */
export function generateTemporaryPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%*-_";
  const all = upper + lower + digits + symbols;
  const pick = (set: string) => set[randomBytes(1)[0] % set.length];
  let output = `Gb-${pick(upper)}${pick(lower)}${pick(digits)}${pick(symbols)}`;
  for (let i = 0; i < 8; i += 1) output += pick(all);
  return output;
}

export function passwordIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < 12) issues.push("Must be at least 12 characters.");
  if (!/[a-z]/.test(password)) issues.push("Must include a lowercase letter.");
  if (!/[A-Z]/.test(password)) issues.push("Must include an uppercase letter.");
  if (!/[0-9]/.test(password)) issues.push("Must include a number.");
  if (!/[^A-Za-z0-9]/.test(password)) issues.push("Must include a symbol.");
  return issues;
}

/* ─────────────────────────── secrets at rest (AES-256-GCM) ─────────────────────────── */

const devMasterSecret = randomBytes(32).toString("hex");
const devMasterSalt = randomBytes(16).toString("hex");

function masterKey(): Buffer {
  const secret = process.env.ENCRYPTION_MASTER_KEY;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("ENCRYPTION_MASTER_KEY must be configured in production");
  const devSecret = secret ?? devMasterSecret;
  const salt = process.env.ENCRYPTION_MASTER_SALT ?? devMasterSalt;
  return scryptSync(devSecret, salt, 32, { N: 4096, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${enc.toString("base64")}`;
}

export function decryptSecret(payload: string): string | null {
  try {
    const [version, ivB64, tagB64, dataB64] = payload.split(".");
    if (version !== "v1") return null;
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/* ─────────────────────────── TOTP (RFC 6238) ─────────────────────────── */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secretBase32: string, timeMs = Date.now(), step = 30): string {
  const counter = Math.floor(timeMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = hmacSha1(base32Decode(secretBase32), buf);
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

/** Verifies a TOTP code with a ±1 step window to absorb clock drift. */
export function verifyTotp(secretBase32: string, token: string, window = 1): boolean {
  const normalized = token.replace(/\D/g, "");
  if (normalized.length !== 6) return false;
  const now = Date.now();
  for (let i = -window; i <= window; i += 1) {
    const candidate = totpCode(secretBase32, now + i * 30_000);
    if (candidate === normalized) return true;
  }
  return false;
}

export function otpauthUrl(secret: string, email: string, issuer = "GlobeBridge Pathways"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(
    email,
  )}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function recoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () =>
    `${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}`,
  );
}
