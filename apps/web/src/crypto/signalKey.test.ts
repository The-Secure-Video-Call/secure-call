import { describe, expect, it } from 'vitest';
import { hkdfSha256 } from '@/crypto/hkdf';
import { SECRET_BYTES } from '@/crypto/secret';
import { SIGNAL_KEY_BYTES, deriveSignalKey, deriveSignalKeyBytes } from '@/crypto/signalKey';

describe('deriveSignalKey', () => {
  const firstRoomSecret = new Uint8Array(SECRET_BYTES).fill(1);
  const secondRoomSecret = new Uint8Array(SECRET_BYTES).fill(2);
  const aesGcmTestIv = new Uint8Array(12);
  const plaintextBytes = new TextEncoder().encode('hello');

  it('derives 32 bytes with HKDF, empty salt and info "signal"', async () => {
    const signalKeyBytes = await deriveSignalKeyBytes(firstRoomSecret);
    expect(signalKeyBytes).toHaveLength(SIGNAL_KEY_BYTES);
    const expectedBytes = await hkdfSha256(
      firstRoomSecret,
      new Uint8Array(0),
      new TextEncoder().encode('signal'),
      32,
    );
    expect(signalKeyBytes).toEqual(expectedBytes);
  });

  it('uses different bytes for "signal" than for "room" (domain separation)', async () => {
    const roomBytes = await hkdfSha256(
      firstRoomSecret,
      new Uint8Array(0),
      new TextEncoder().encode('room'),
      32,
    );
    expect(await deriveSignalKeyBytes(firstRoomSecret)).not.toEqual(roomBytes);
  });

  it('returns a non-extractable AES-GCM 256-bit key for encrypt and decrypt only', async () => {
    const signalKey = await deriveSignalKey(firstRoomSecret);
    expect(signalKey.type).toBe('secret');
    expect(signalKey.extractable).toBe(false);
    expect(signalKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect([...signalKey.usages].sort()).toEqual(['decrypt', 'encrypt']);
  });

  it('can encrypt and decrypt', async () => {
    const signalKey = await deriveSignalKey(firstRoomSecret);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: aesGcmTestIv },
      signalKey,
      plaintextBytes,
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: aesGcmTestIv },
      signalKey,
      ciphertext,
    );
    expect(new Uint8Array(decrypted)).toEqual(plaintextBytes);
  });

  it('cannot be exported', async () => {
    const signalKey = await deriveSignalKey(firstRoomSecret);
    await expect(crypto.subtle.exportKey('raw', signalKey)).rejects.toThrow();
  });

  it('cannot be used for anything other than encrypt and decrypt', async () => {
    const signalKey = await deriveSignalKey(firstRoomSecret);
    await expect(
      crypto.subtle.wrapKey('raw', signalKey, signalKey, { name: 'AES-GCM', iv: aesGcmTestIv }),
    ).rejects.toThrow();
    await expect(crypto.subtle.sign('HMAC', signalKey, plaintextBytes)).rejects.toThrow();
  });

  it('gives a different key for a different secret', async () => {
    const ciphertextFromFirstKey = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: aesGcmTestIv },
      await deriveSignalKey(firstRoomSecret),
      plaintextBytes,
    );
    await expect(
      crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: aesGcmTestIv },
        await deriveSignalKey(secondRoomSecret),
        ciphertextFromFirstKey,
      ),
    ).rejects.toThrow();
    expect(await deriveSignalKeyBytes(firstRoomSecret)).not.toEqual(
      await deriveSignalKeyBytes(secondRoomSecret),
    );
  });

  it('rejects a secret of the wrong length', async () => {
    await expect(deriveSignalKey(new Uint8Array(SECRET_BYTES - 1))).rejects.toThrow();
    await expect(deriveSignalKey(new Uint8Array(SECRET_BYTES + 1))).rejects.toThrow();
    await expect(deriveSignalKey(new Uint8Array(0))).rejects.toThrow();
  });
});
