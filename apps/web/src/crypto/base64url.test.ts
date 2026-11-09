import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from '@/crypto/base64url';

describe('base64url', () => {
  it('uses the URL-safe alphabet without padding', () => {
    expect(toBase64Url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect(toBase64Url(new Uint8Array([1]))).toBe('AQ');
    expect(fromBase64Url('AQ')).toEqual(new Uint8Array([1]));
    expect(fromBase64Url('A+/=')).toBeNull();
  });
});
