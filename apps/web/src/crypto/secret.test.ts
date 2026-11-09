import { describe, expect, it } from 'vitest';
import { toBase64Url } from '@/crypto/base64url';
import { decodeSecret, encodeSecret, generateSecret } from '@/crypto/secret';

describe('secret', () => {
  it('generates 32 random bytes that round-trip through base64url', () => {
    const generatedSecret = generateSecret();
    expect(generatedSecret.length).toBe(32);
    expect(generateSecret()).not.toEqual(generatedSecret);
    expect(decodeSecret(encodeSecret(generatedSecret))).toEqual(generatedSecret);
  });

  it('rejects malformed, short and oversized fragments', () => {
    expect(decodeSecret('')).toBeNull();
    expect(decodeSecret('abc')).toBeNull();
    expect(decodeSecret('not base64url!!')).toBeNull();
    expect(decodeSecret(toBase64Url(new Uint8Array(31)))).toBeNull();
    expect(decodeSecret(toBase64Url(new Uint8Array(33)))).toBeNull();
    expect(decodeSecret(encodeSecret(generateSecret()) + 'A')).toBeNull();
  });
});
