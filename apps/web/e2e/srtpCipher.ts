// Which SRTP cipher protects the media of a call (ASVS 5.0 V11.3.2). Browsers report the IANA
// DTLS-SRTP profile names (`SRTP_...`) and keep SRTP_AES128_CM_HMAC_SHA1_80 (CTR mode, HMAC-SHA1) enabled next to the AEAD-GCM profiles, so a call
// could silently use it. The end-to-end test reads the transport stats and judges them here.

/** The only SRTP ciphers ASVS Appendix C approves (AES-GCM). */
export const APPROVED_SRTP_CIPHERS: readonly string[] = [
  'SRTP_AEAD_AES_128_GCM',
  'SRTP_AEAD_AES_256_GCM',
];

export type SrtpCipherVerdict =
  /** Every transport that reports a cipher uses an approved one. */
  | { status: 'approved'; ciphers: string[] }
  /** A transport uses a cipher that is not approved, or one we do not know. */
  | { status: 'rejected'; ciphers: string[] }
  /** No transport reports `srtpCipher` at all: the browser gives us nothing to judge. */
  | { status: 'not-reported'; ciphers: string[] };

/** True only for an exact match with an approved cipher name (no trimming, no case folding). */
export function isApprovedSrtpCipher(srtpCipher: unknown): boolean {
  return typeof srtpCipher === 'string' && APPROVED_SRTP_CIPHERS.includes(srtpCipher);
}

/**
 * Judges the entries of an RTCStatsReport. Only `transport` entries count. A transport that
 * reports an empty or non-string cipher is treated as rejected, never as "not reported", so an
 * odd value cannot slip through as a gap.
 */
export function judgeSrtpCipher(
  statsEntries: readonly Record<string, unknown>[],
): SrtpCipherVerdict {
  const transportEntries = statsEntries.filter((statsEntry) => statsEntry.type === 'transport');
  const reportedCiphers: unknown[] = transportEntries
    .filter((transportEntry) => 'srtpCipher' in transportEntry)
    .map((transportEntry) => transportEntry.srtpCipher);
  const ciphers = reportedCiphers.map((srtpCipher) => String(srtpCipher));
  if (!reportedCiphers.every(isApprovedSrtpCipher)) return { status: 'rejected', ciphers };
  // A connected transport that says nothing about its cipher cannot be judged: never a pass.
  const hasConnectedTransportWithoutCipher = transportEntries.some(
    (transportEntry) =>
      transportEntry.dtlsState === 'connected' && !('srtpCipher' in transportEntry),
  );
  if (reportedCiphers.length === 0 || hasConnectedTransportWithoutCipher) {
    return { status: 'not-reported', ciphers };
  }
  return { status: 'approved', ciphers };
}
