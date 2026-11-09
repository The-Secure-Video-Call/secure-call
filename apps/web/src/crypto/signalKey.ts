import { hkdfSha256 } from '@/crypto/hkdf';
import { SECRET_BYTES } from '@/crypto/secret';

export const SIGNAL_KEY_BYTES = 32;

/**
 * Raw signal key bytes: HKDF-SHA256, empty salt, info "signal", 32 bytes. Kept separate from
 * `deriveSignalKey` so the derivation can be checked against a known-answer vector. Never log
 * or store the result; use `deriveSignalKey` to get a non-extractable key instead. Exported for
 * tests only: do not import it from application code.
 */
export async function deriveSignalKeyBytes(roomSecret: Uint8Array): Promise<Uint8Array> {
  if (roomSecret.length !== SECRET_BYTES) {
    throw new Error('Room secret has the wrong length');
  }
  return hkdfSha256(
    roomSecret,
    new Uint8Array(0),
    new TextEncoder().encode('signal'),
    SIGNAL_KEY_BYTES,
  );
}

/**
 * Derive the key that encrypts signaling messages: an AES-GCM 256-bit CryptoKey, non-extractable,
 * usable only for encrypt and decrypt.
 */
export async function deriveSignalKey(roomSecret: Uint8Array): Promise<CryptoKey> {
  const signalKeyBytes = await deriveSignalKeyBytes(roomSecret);
  try {
    return await crypto.subtle.importKey(
      'raw',
      signalKeyBytes as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    signalKeyBytes.fill(0);
  }
}
