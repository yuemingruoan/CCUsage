// Password and API-token primitives for the sync server.
//
// Passwords are stored as scrypt hashes with a per-account random salt; API
// tokens are random 256-bit values returned to the client once and stored as
// SHA-256 hashes so a database leak does not leak usable bearer tokens.

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const TOKEN_BYTES = 32;

export interface PasswordRecord {
  passwordHash: string;
  salt: string;
}

/** scrypt with the Node defaults (N=16384, r=8, p=1) and a random 16-byte salt. */
export function hashPassword(password: string): PasswordRecord {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const passwordHash = scryptSync(password, salt, KEY_BYTES).toString("hex");
  return { passwordHash, salt };
}

/** Constant-time check; any malformed stored hash simply fails. */
export function verifyPassword(password: string, passwordHash: string, salt: string): boolean {
  const expected = Buffer.from(passwordHash, "hex");
  if (expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 32 random bytes, hex encoded: the value handed to the client (never stored). */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/** SHA-256 hex of a bearer token: the value stored in the tokens table. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateId(): string {
  return randomUUID();
}

/** Parses "Bearer <token>" (case-insensitive scheme). */
export function parseBearerToken(header: string | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer[ \t]+([A-Za-z0-9._~+\/-]+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}
