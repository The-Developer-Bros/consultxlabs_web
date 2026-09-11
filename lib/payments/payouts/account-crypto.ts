/**
 * Bank Account Number Encryption — AES-256-GCM
 *
 * Mirrors the pattern in lib/payments/tax/pan-crypto.ts.
 *
 * Format: [12 bytes IV][ciphertext][16 bytes auth tag]
 * Key: ORG_PAYOUT_ENCRYPTION_KEY env var (64 hex chars = 32 bytes)
 *
 * Generate key: openssl rand -hex 32
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.ORG_PAYOUT_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ORG_PAYOUT_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes). " +
        "Generate with: openssl rand -hex 32",
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt a bank account number.
 * Returns { encrypted: Uint8Array (IV + ciphertext + auth tag), last4: string }
 */
export function encryptAccountNumber(accountNumber: string): {
  encrypted: Uint8Array<ArrayBuffer>;
  last4: string;
} {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(accountNumber, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, encrypted, authTag]);
  const result = new Uint8Array(combined.length);
  result.set(combined);

  return {
    encrypted: result,
    last4: accountNumber.slice(-4),
  };
}

/**
 * Decrypt a bank account number buffer back to plaintext.
 * Only needed for payout processing (admin-only operations).
 */
export function decryptAccountNumber(combined: Buffer): string {
  const key = getKey();

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(
    IV_LENGTH,
    combined.length - AUTH_TAG_LENGTH,
  );

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

const ENVELOPE_PREFIX = "enc:v1:";

export function encodeAccountEnvelope(accountNumber: string): string {
  const { encrypted } = encryptAccountNumber(accountNumber);
  return `${ENVELOPE_PREFIX}${Buffer.from(encrypted).toString("base64")}`;
}

export function decodeAccountEnvelope(stored: string): string {
  if (!stored.startsWith(ENVELOPE_PREFIX)) {
    throw new Error(
      "decodeAccountEnvelope: stored value is not an enc:v1 envelope",
    );
  }
  const combined = Buffer.from(stored.slice(ENVELOPE_PREFIX.length), "base64");
  return decryptAccountNumber(combined);
}
