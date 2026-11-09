import { toBase64Url } from '@/crypto/base64url';
import { hkdfSha256 } from '@/crypto/hkdf';

export const ROOM_ID_BYTES = 16;

/**
 * Derive the public room ID from the secret: HKDF-SHA256, empty salt, info "room", 16 bytes,
 * base64url. Only this value may be sent to the server; it does not reveal the secret.
 */
export async function deriveRoomId(roomSecret: Uint8Array): Promise<string> {
  const roomIdBytes = await hkdfSha256(
    roomSecret,
    new Uint8Array(0),
    new TextEncoder().encode('room'),
    ROOM_ID_BYTES,
  );
  return toBase64Url(roomIdBytes);
}
