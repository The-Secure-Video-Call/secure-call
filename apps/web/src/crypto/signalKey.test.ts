import { describe, expect, it } from 'vitest';
import { hkdfSha256 } from '@/crypto/hkdf';
import { deriveRoomId } from '@/crypto/roomId';
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

  // Known-answer vector, computed outside our code with Python hmac + hashlib (HKDF-SHA256,
  // RFC 5869) and cross-checked with OpenSSL 3.6 (`openssl kdf ... HKDF`). Input: secret = 32
  // bytes of 0x01, empty salt. info "signal" -> 32 bytes; info "room" -> first 16 bytes.
  const knownAnswerSignalKeyHex =
    '0c93a41be59992a0c3bdd12a3dda9b29c3dca5aa380d10ee809c9d022c5ec281';
  // Room ID bytes were b14b4b0fa71ea2080d5351d8dd211054; this is their unpadded base64url.
  const knownAnswerRoomId = 'sUtLD6ceoggNU1HY3SEQVA';

  function bytesToHex(bytesToConvert: Uint8Array): string {
    return [...bytesToConvert].map((byteValue) => byteValue.toString(16).padStart(2, '0')).join('');
  }

  it('matches the known-answer vector for the signal key bytes', async () => {
    expect(bytesToHex(await deriveSignalKeyBytes(firstRoomSecret))).toBe(knownAnswerSignalKeyHex);
  });

  it('matches the known-answer vector for the room ID', async () => {
    expect(await deriveRoomId(firstRoomSecret)).toBe(knownAnswerRoomId);
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
