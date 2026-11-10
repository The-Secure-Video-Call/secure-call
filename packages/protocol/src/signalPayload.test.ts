import { describe, expect, it } from 'vitest';
import { signalPayloadSchema } from '@protocol/signalPayload';

const SESSION_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const FINGERPRINT_COMMITMENT = 'h7K3UkoRUlNBon5zZ_ojP5B4qVxjbD5I_aK00CNuOoM';

function hello(data: Record<string, unknown>) {
  return { kind: 'hello', data, seq: 0 };
}

describe('signalPayloadSchema: hello', () => {
  it('accepts a session ID with a 43-character fingerprint commitment', () => {
    const payload = hello({ sessionId: SESSION_ID, fingerprintCommitment: FINGERPRINT_COMMITMENT });
    expect(signalPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('negative: requires the commitment, exactly 43 base64url characters, and nothing else', () => {
    for (const data of [
      { sessionId: SESSION_ID },
      { sessionId: SESSION_ID, fingerprintCommitment: FINGERPRINT_COMMITMENT.slice(0, 42) },
      { sessionId: SESSION_ID, fingerprintCommitment: `${FINGERPRINT_COMMITMENT}A` },
      { sessionId: SESSION_ID, fingerprintCommitment: FINGERPRINT_COMMITMENT.replace('_', '/') },
      { sessionId: SESSION_ID, fingerprintCommitment: `${FINGERPRINT_COMMITMENT.slice(0, 42)}=` },
      { sessionId: SESSION_ID, fingerprintCommitment: null },
      { sessionId: SESSION_ID, fingerprintCommitment: FINGERPRINT_COMMITMENT, extra: true },
    ]) {
      expect(signalPayloadSchema.safeParse(hello(data)).success, JSON.stringify(data)).toBe(false);
    }
  });
});
