import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from './base64url';
import { hkdfSha256 } from './hkdf';
import { deriveRoomId } from './roomId';
import { SECRET_BYTES, decodeSecret, encodeSecret, generateSecret } from './secret';

const fromHex = (hex: string) =>
  new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('hkdfSha256', () => {
  it('matches RFC 5869 test case 1 (known answer)', async () => {
    const okm = await hkdfSha256(
      fromHex('0b'.repeat(22)),
      fromHex('000102030405060708090a0b0c'),
      fromHex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(toHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });
});

describe('deriveRoomId', () => {
  const secretA = new Uint8Array(SECRET_BYTES).fill(1);
  const secretB = new Uint8Array(SECRET_BYTES).fill(2);

  it('is deterministic, 16 bytes of base64url (22 chars)', async () => {
    const id = await deriveRoomId(secretA);
    expect(id).toBe(await deriveRoomId(secretA));
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('equals HKDF with info "room" and 16 bytes', async () => {
    const okm = await hkdfSha256(secretA, new Uint8Array(0), new TextEncoder().encode('room'), 16);
    expect(await deriveRoomId(secretA)).toBe(toBase64Url(okm));
  });

  it('gives different IDs for different secrets', async () => {
    expect(await deriveRoomId(secretA)).not.toBe(await deriveRoomId(secretB));
  });

  it('does not contain the secret', async () => {
    expect(await deriveRoomId(secretA)).not.toContain(encodeSecret(secretA));
  });
});

describe('secret', () => {
  it('generates 32 random bytes that round-trip through base64url', () => {
    const s = generateSecret();
    expect(s.length).toBe(32);
    expect(generateSecret()).not.toEqual(s);
    expect(decodeSecret(encodeSecret(s))).toEqual(s);
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

describe('base64url', () => {
  it('uses the URL-safe alphabet without padding', () => {
    expect(toBase64Url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect(toBase64Url(new Uint8Array([1]))).toBe('AQ');
    expect(fromBase64Url('AQ')).toEqual(new Uint8Array([1]));
    expect(fromBase64Url('A+/=')).toBeNull();
  });
});
