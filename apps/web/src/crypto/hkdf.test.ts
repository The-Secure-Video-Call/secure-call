import { describe, expect, it } from 'vitest';
import { hkdfSha256 } from '@/crypto/hkdf';

const bytesFromHex = (hexText: string) =>
  new Uint8Array((hexText.match(/../g) ?? []).map((hexPair) => parseInt(hexPair, 16)));
const hexFromBytes = (bytesToShow: Uint8Array) =>
  [...bytesToShow].map((byteValue) => byteValue.toString(16).padStart(2, '0')).join('');

describe('hkdfSha256', () => {
  it('matches RFC 5869 test case 1 (known answer)', async () => {
    const derivedKeyMaterial = await hkdfSha256(
      bytesFromHex('0b'.repeat(22)),
      bytesFromHex('000102030405060708090a0b0c'),
      bytesFromHex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(hexFromBytes(derivedKeyMaterial)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });
});
