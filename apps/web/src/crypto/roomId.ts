import { toBase64Url } from './base64url';
import { hkdfSha256 } from './hkdf';

export const ROOM_ID_BYTES = 16;

/**
 * Derive the public room ID from the secret: HKDF-SHA256, empty salt, info "room", 16 bytes,
 * base64url. Only this value may be sent to the server; it does not reveal the secret.
 */
export async function deriveRoomId(secret: Uint8Array): Promise<string> {
  const okm = await hkdfSha256(
    secret,
    new Uint8Array(0),
    new TextEncoder().encode('room'),
    ROOM_ID_BYTES,
  );
  return toBase64Url(okm);
}
