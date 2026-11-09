import { describe, expect, it } from 'vitest';
import { toBase64Url } from '@/crypto/base64url';
import { hkdfSha256 } from '@/crypto/hkdf';
import { deriveRoomId } from '@/crypto/roomId';
import { SECRET_BYTES, encodeSecret } from '@/crypto/secret';

describe('deriveRoomId', () => {
  const firstRoomSecret = new Uint8Array(SECRET_BYTES).fill(1);
  const secondRoomSecret = new Uint8Array(SECRET_BYTES).fill(2);

  it('is deterministic, 16 bytes of base64url (22 chars)', async () => {
    const roomId = await deriveRoomId(firstRoomSecret);
    expect(roomId).toBe(await deriveRoomId(firstRoomSecret));
    expect(roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('equals HKDF with info "room" and 16 bytes', async () => {
    const expectedRoomIdBytes = await hkdfSha256(
      firstRoomSecret,
      new Uint8Array(0),
      new TextEncoder().encode('room'),
      16,
    );
    expect(await deriveRoomId(firstRoomSecret)).toBe(toBase64Url(expectedRoomIdBytes));
  });

  it('gives different IDs for different secrets', async () => {
    expect(await deriveRoomId(firstRoomSecret)).not.toBe(await deriveRoomId(secondRoomSecret));
  });

  it('does not contain the secret', async () => {
    expect(await deriveRoomId(firstRoomSecret)).not.toContain(encodeSecret(firstRoomSecret));
  });
});
