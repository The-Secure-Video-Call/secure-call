import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from '@/crypto/base64';

describe('base64', () => {
  it('round-trips bytes of every length remainder', () => {
    for (const length of [1, 2, 3, 4, 12, 16]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 5) % 256);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
  });

  it('rejects non-canonical or malformed text', () => {
    expect(fromBase64('')).toBeNull();
    expect(fromBase64('QUJD*')).toBeNull();
    expect(fromBase64('QUJ')).toBeNull(); // missing padding
    expect(fromBase64('QUJD=')).toBeNull();
    expect(fromBase64('QR==')).toBeNull(); // nonzero leftover bits
    expect(fromBase64('QUJD\n')).toBeNull();
  });
});
