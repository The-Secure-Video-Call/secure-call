import { fromBase64Url, toBase64Url } from '@/crypto/base64url';

export const SECRET_BYTES = 32;

/** A fresh random room secret (32 bytes from the browser's secure random generator). */
export function generateSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

/** Encode a room secret for the URL fragment. */
export function encodeSecret(roomSecret: Uint8Array): string {
  return toBase64Url(roomSecret);
}

/** Decode a fragment value. Returns null unless it is exactly a 32-byte base64url secret. */
export function decodeSecret(fragmentText: string): Uint8Array | null {
  const decodedSecretBytes = fromBase64Url(fragmentText);
  return decodedSecretBytes && decodedSecretBytes.length === SECRET_BYTES
    ? decodedSecretBytes
    : null;
}
