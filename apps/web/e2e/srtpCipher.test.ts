import { describe, expect, it } from 'vitest';
import { isApprovedSrtpCipher, judgeSrtpCipher } from './srtpCipher.ts';

function transportWith(srtpCipher: unknown) {
  return { type: 'transport', id: 'T01', srtpCipher };
}

describe('isApprovedSrtpCipher', () => {
  it('accepts the two AES-GCM profiles', () => {
    expect(isApprovedSrtpCipher('AEAD_AES_128_GCM')).toBe(true);
    expect(isApprovedSrtpCipher('AEAD_AES_256_GCM')).toBe(true);
  });

  it('rejects the CTR + HMAC-SHA1 profile, unknown names and look-alikes', () => {
    for (const srtpCipher of [
      'AES_CM_128_HMAC_SHA1_80',
      'AES_CM_128_HMAC_SHA1_32',
      'aead_aes_128_gcm',
      ' AEAD_AES_128_GCM',
      'AEAD_AES_128_GCM_EXTRA',
      '',
      'something new',
      undefined,
      null,
      128,
    ]) {
      expect(isApprovedSrtpCipher(srtpCipher), String(srtpCipher)).toBe(false);
    }
  });
});

describe('judgeSrtpCipher', () => {
  it('approves a transport using AES-GCM', () => {
    expect(judgeSrtpCipher([transportWith('AEAD_AES_256_GCM')])).toEqual({
      status: 'approved',
      ciphers: ['AEAD_AES_256_GCM'],
    });
  });

  it('rejects a transport using AES_CM_128_HMAC_SHA1_80', () => {
    expect(judgeSrtpCipher([transportWith('AES_CM_128_HMAC_SHA1_80')]).status).toBe('rejected');
  });

  it('rejects an unknown or empty cipher value instead of calling it a gap', () => {
    expect(judgeSrtpCipher([transportWith('NEW_PROFILE')]).status).toBe('rejected');
    expect(judgeSrtpCipher([transportWith('')]).status).toBe('rejected');
    expect(judgeSrtpCipher([transportWith(undefined)]).status).toBe('rejected');
  });

  it('rejects when any one transport uses a bad cipher', () => {
    const verdict = judgeSrtpCipher([
      transportWith('AEAD_AES_128_GCM'),
      transportWith('AES_CM_128_HMAC_SHA1_80'),
    ]);
    expect(verdict.status).toBe('rejected');
  });

  it('reports not-reported when no transport has srtpCipher, never approved', () => {
    expect(judgeSrtpCipher([]).status).toBe('not-reported');
    expect(judgeSrtpCipher([{ type: 'transport', id: 'T01' }]).status).toBe('not-reported');
  });

  it('does not approve when a connected transport reports no cipher', () => {
    const verdict = judgeSrtpCipher([
      transportWith('AEAD_AES_128_GCM'),
      { type: 'transport', id: 'T02', dtlsState: 'connected' },
    ]);
    expect(verdict.status).toBe('not-reported');
  });

  it('ignores a cipher on an entry that is not a transport', () => {
    const verdict = judgeSrtpCipher([{ type: 'candidate-pair', srtpCipher: 'AEAD_AES_128_GCM' }]);
    expect(verdict.status).toBe('not-reported');
  });
});
