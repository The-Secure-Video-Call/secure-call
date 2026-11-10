import { describe, expect, it } from 'vitest';
import { toBase64Url } from '@/crypto/base64url';
import {
  computeFingerprintCommitment,
  doesSdpMatchFingerprintCommitment,
  isWellFormedFingerprintCommitment,
} from '@/crypto/fingerprintCommitment';

const FINGERPRINT = `sha-256 ${Array.from({ length: 32 }, () => 'AB').join(':')}`;
const OTHER_FINGERPRINT = `sha-256 ${Array.from({ length: 32 }, () => 'CD').join(':')}`;
// Computed independently with Python's hashlib:
// base64url(sha256(b"secure-call/fp-commit/v1\n" + FINGERPRINT)), unpadded.
const FINGERPRINT_COMMITMENT = 'h7K3UkoRUlNBon5zZ_ojP5B4qVxjbD5I_aK00CNuOoM';

function sdpWithFingerprints(...fingerprints: string[]): string {
  return [
    'v=0',
    'o=- 1 1 IN IP4 0.0.0.0',
    's=-',
    ...fingerprints.map((fingerprint) => `a=fingerprint:${fingerprint}`),
    '',
  ].join('\r\n');
}

describe('fingerprint commitment', () => {
  it('is SHA-256 over the label, a newline and the normalised fingerprint (known answer)', async () => {
    expect(await computeFingerprintCommitment(FINGERPRINT)).toBe(FINGERPRINT_COMMITMENT);
  });

  it('is 43 base64url characters and differs for another fingerprint', async () => {
    const otherCommitment = await computeFingerprintCommitment(OTHER_FINGERPRINT);
    expect(otherCommitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(otherCommitment).not.toBe(FINGERPRINT_COMMITMENT);
  });

  it('matches an SDP carrying exactly the committed fingerprint, in any letter case', async () => {
    expect(
      await doesSdpMatchFingerprintCommitment(
        sdpWithFingerprints(FINGERPRINT),
        FINGERPRINT_COMMITMENT,
      ),
    ).toBe(true);
    expect(
      await doesSdpMatchFingerprintCommitment(
        sdpWithFingerprints(FINGERPRINT.toLowerCase(), FINGERPRINT),
        FINGERPRINT_COMMITMENT,
      ),
    ).toBe(true);
  });

  it('negative: another fingerprint, none, several different or a malformed one does not match', async () => {
    for (const sdp of [
      sdpWithFingerprints(OTHER_FINGERPRINT),
      sdpWithFingerprints(),
      sdpWithFingerprints(FINGERPRINT, OTHER_FINGERPRINT),
      sdpWithFingerprints('sha-256 AB:CD'),
      sdpWithFingerprints(FINGERPRINT.replace('sha-256', 'sha-1')),
      sdpWithFingerprints(FINGERPRINT.replace('sha-256', 'sha-384')),
    ]) {
      expect(await doesSdpMatchFingerprintCommitment(sdp, FINGERPRINT_COMMITMENT)).toBe(false);
    }
  });

  it('negative: a commitment without the label, or over the bare hex, does not match', async () => {
    const bareDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(FINGERPRINT));
    const withoutLabel = toBase64Url(new Uint8Array(bareDigest));
    expect(
      await doesSdpMatchFingerprintCommitment(sdpWithFingerprints(FINGERPRINT), withoutLabel),
    ).toBe(false);
  });

  it('accepts only 32 bytes in canonical unpadded base64url', () => {
    expect(isWellFormedFingerprintCommitment(FINGERPRINT_COMMITMENT)).toBe(true);
    // The last character carries 2 unused bits: 'M' is canonical here, 'N' encodes the same bytes.
    expect(FINGERPRINT_COMMITMENT.endsWith('M')).toBe(true);
    for (const malformed of [
      `${FINGERPRINT_COMMITMENT.slice(0, -1)}N`,
      FINGERPRINT_COMMITMENT.slice(0, -1),
      `${FINGERPRINT_COMMITMENT}A`,
      `${FINGERPRINT_COMMITMENT}=`,
      FINGERPRINT_COMMITMENT.replace('_', '/'),
      '',
    ]) {
      expect(isWellFormedFingerprintCommitment(malformed)).toBe(false);
    }
  });
});
