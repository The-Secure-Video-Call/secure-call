import { fromBase64Url, toBase64Url } from './base64url';

export const SECRET_BYTES = 32;

/** A fresh random room secret (32 bytes from the CSPRNG). */
export function generateSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

/** Encode a secret for use in a URL fragment. */
export function encodeSecret(secret: Uint8Array): string {
  return toBase64Url(secret);
}

/** Decode a fragment value. Returns null unless it is exactly a 32-byte base64url secret. */
export function decodeSecret(text: string): Uint8Array | null {
  const bytes = fromBase64Url(text);
  return bytes && bytes.length === SECRET_BYTES ? bytes : null;
}
