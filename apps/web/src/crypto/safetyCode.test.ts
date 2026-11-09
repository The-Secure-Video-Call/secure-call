import { describe, expect, it } from 'vitest';
import {
  SAFETY_CODE_EMOJI,
  SafetyCodeError,
  computeSafetyCodeIndices,
  readFingerprintFromSdp,
  safetyCodeIndicesToDigits,
  safetyCodeIndicesToEmoji,
} from '@/crypto/safetyCode';

function hexFingerprint(byteAt: (position: number) => number): string {
  return Array.from({ length: 32 }, (_unused, position) =>
    byteAt(position).toString(16).toUpperCase().padStart(2, '0'),
  ).join(':');
}

function sdpWithFingerprintLine(fingerprintLine: string): string {
  return ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', fingerprintLine, 'a=setup:actpass'].join('\r\n');
}

const firstFingerprintHex = hexFingerprint((position) => position);
const secondFingerprintHex = hexFingerprint((position) => 255 - position);
const firstSdp = sdpWithFingerprintLine(`a=fingerprint:sha-256 ${firstFingerprintHex}`);
const secondSdp = sdpWithFingerprintLine(`a=fingerprint:sha-256 ${secondFingerprintHex}`);

describe('readFingerprintFromSdp', () => {
  it('normalises hash name to lowercase and hex to uppercase', () => {
    const sdp = sdpWithFingerprintLine(
      `a=fingerprint:SHA-256 ${firstFingerprintHex.toLowerCase()}`,
    );
    expect(readFingerprintFromSdp(sdp)).toBe(`sha-256 ${firstFingerprintHex}`);
  });

  it('accepts a session-level fingerprint', () => {
    const sdp = `v=0\na=fingerprint:sha-256 ${firstFingerprintHex}\nm=audio 9 RTP/AVP 0\n`;
    expect(readFingerprintFromSdp(sdp)).toBe(`sha-256 ${firstFingerprintHex}`);
  });

  it('accepts the same fingerprint repeated on several media sections', () => {
    const line = `a=fingerprint:sha-256 ${firstFingerprintHex}`;
    expect(readFingerprintFromSdp(`${line}\r\nm=video\r\n${line.toLowerCase()}`)).toBe(
      `sha-256 ${firstFingerprintHex}`,
    );
  });

  it('rejects an SDP with no fingerprint', () => {
    expect(() => readFingerprintFromSdp('v=0\r\nm=audio 9 RTP/AVP 0')).toThrow(SafetyCodeError);
  });

  it('rejects two different fingerprints', () => {
    const sdp = `${firstSdp}\r\na=fingerprint:sha-256 ${secondFingerprintHex}`;
    expect(() => readFingerprintFromSdp(sdp)).toThrow(SafetyCodeError);
  });

  it.each([
    ['no hex part', 'a=fingerprint:sha-256'],
    [
      'sha-1 is not accepted',
      `a=fingerprint:sha-1 ${firstFingerprintHex.split(':').slice(0, 20).join(':')}`,
    ],
    ['unknown hash', `a=fingerprint:md5 ${firstFingerprintHex}`],
    ['prototype property as hash', `a=fingerprint:constructor ${firstFingerprintHex}`],
    ['non-hex characters', `a=fingerprint:sha-256 ${firstFingerprintHex.replace('00', 'ZZ')}`],
    ['too few bytes', `a=fingerprint:sha-256 ${firstFingerprintHex.slice(0, -3)}`],
    ['missing colons', `a=fingerprint:sha-256 ${firstFingerprintHex.replaceAll(':', '')}`],
    ['extra part', `a=fingerprint:sha-256 ${firstFingerprintHex} extra`],
  ])('rejects a malformed line: %s', (_description, fingerprintLine) => {
    expect(() => readFingerprintFromSdp(sdpWithFingerprintLine(fingerprintLine))).toThrow(
      SafetyCodeError,
    );
  });

  it('does not put SDP content into the error message', () => {
    try {
      readFingerprintFromSdp(sdpWithFingerprintLine('a=fingerprint:sha-256 SECRET-VALUE'));
      expect.unreachable();
    } catch (caughtError) {
      expect((caughtError as Error).message).not.toContain('SECRET-VALUE');
    }
  });
});

describe('computeSafetyCodeIndices', () => {
  it('gives six indices between 0 and 63', async () => {
    const safetyCodeIndices = await computeSafetyCodeIndices(firstSdp, secondSdp);
    expect(safetyCodeIndices).toHaveLength(6);
    for (const safetyCodeIndex of safetyCodeIndices) {
      expect(Number.isInteger(safetyCodeIndex)).toBe(true);
      expect(safetyCodeIndex).toBeGreaterThanOrEqual(0);
      expect(safetyCodeIndex).toBeLessThan(64);
    }
  });

  it('matches a separate reading of the first 36 bits of SHA-256(sorted, "\\n"-joined)', async () => {
    const hashInput = [`sha-256 ${firstFingerprintHex}`, `sha-256 ${secondFingerprintHex}`]
      .sort()
      .join('\n');
    const hashBytes = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashInput)),
    );
    let first40Bits = 0n;
    for (const hashByte of hashBytes.subarray(0, 5))
      first40Bits = (first40Bits << 8n) | BigInt(hashByte);
    const first36Bits = first40Bits >> 4n;
    const expectedIndices = [30n, 24n, 18n, 12n, 6n, 0n].map((shift) =>
      Number((first36Bits >> shift) & 63n),
    );
    expect(await computeSafetyCodeIndices(firstSdp, secondSdp)).toEqual(expectedIndices);
  });

  it('gives the known answer computed outside our code', async () => {
    // Computed with Python hashlib, not with this code: the strings `sha-256 <firstFingerprintHex>`
    // and `sha-256 <secondFingerprintHex>`, sorted and joined with "\n", hash with SHA-256 to
    // something starting 9f0f827a16; its first 36 bits as six 6-bit numbers are these indices.
    expect(await computeSafetyCodeIndices(firstSdp, secondSdp)).toEqual([39, 48, 62, 2, 30, 33]);
  });

  it('is the same when local and remote are swapped', async () => {
    expect(await computeSafetyCodeIndices(firstSdp, secondSdp)).toEqual(
      await computeSafetyCodeIndices(secondSdp, firstSdp),
    );
  });

  it('changes when one character of either fingerprint changes', async () => {
    const original = await computeSafetyCodeIndices(firstSdp, secondSdp);
    const tamperedFirstSdp = sdpWithFingerprintLine(
      `a=fingerprint:sha-256 ${firstFingerprintHex.replace(/^00/, '01')}`,
    );
    const tamperedSecondSdp = sdpWithFingerprintLine(
      `a=fingerprint:sha-256 ${secondFingerprintHex.replace(/E0$/, 'E1')}`,
    );
    expect(await computeSafetyCodeIndices(tamperedFirstSdp, secondSdp)).not.toEqual(original);
    expect(tamperedSecondSdp).not.toBe(secondSdp);
    expect(await computeSafetyCodeIndices(firstSdp, tamperedSecondSdp)).not.toEqual(original);
  });

  it('rejects when either side has no fingerprint, two different ones, or a malformed one', async () => {
    await expect(computeSafetyCodeIndices('v=0', secondSdp)).rejects.toThrow(SafetyCodeError);
    await expect(computeSafetyCodeIndices(firstSdp, 'v=0')).rejects.toThrow(SafetyCodeError);
    await expect(
      computeSafetyCodeIndices(
        `${firstSdp}\r\na=fingerprint:sha-256 ${secondFingerprintHex}`,
        secondSdp,
      ),
    ).rejects.toThrow(SafetyCodeError);
    await expect(
      computeSafetyCodeIndices(firstSdp, sdpWithFingerprintLine('a=fingerprint:sha-256 AB:CD')),
    ).rejects.toThrow(SafetyCodeError);
  });
});

describe('SAFETY_CODE_EMOJI', () => {
  it('has exactly 64 entries, with no duplicate emoji or names', () => {
    expect(SAFETY_CODE_EMOJI).toHaveLength(64);
    expect(new Set(SAFETY_CODE_EMOJI.map((entry) => entry.emoji)).size).toBe(64);
    expect(new Set(SAFETY_CODE_EMOJI.map((entry) => entry.name)).size).toBe(64);
  });

  it('uses single code points only (no ZWJ, variation selectors or skin tones)', () => {
    for (const { emoji, name } of SAFETY_CODE_EMOJI) {
      expect([...emoji], name).toHaveLength(1);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('keeps the protocol order stable at its ends', () => {
    expect(SAFETY_CODE_EMOJI[0]?.name).toBe('dog');
    expect(SAFETY_CODE_EMOJI[63]?.name).toBe('gem');
  });
});

describe('code formatting', () => {
  it('shows the same indices as emoji and as two-digit numbers', () => {
    const safetyCodeIndices = [0, 7, 9, 31, 62, 63];
    expect(safetyCodeIndicesToDigits(safetyCodeIndices)).toEqual([
      '00',
      '07',
      '09',
      '31',
      '62',
      '63',
    ]);
    expect(safetyCodeIndicesToEmoji(safetyCodeIndices).map((entry) => entry.name)).toEqual(
      safetyCodeIndices.map((safetyCodeIndex) => SAFETY_CODE_EMOJI[safetyCodeIndex]?.name),
    );
  });

  it('rejects an index outside 0..63', () => {
    expect(() => safetyCodeIndicesToEmoji([64])).toThrow(RangeError);
    expect(() => safetyCodeIndicesToEmoji([-1])).toThrow(RangeError);
  });
});
