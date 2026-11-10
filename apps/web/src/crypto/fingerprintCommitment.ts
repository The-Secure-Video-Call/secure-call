/**
 * Commitment to a DTLS fingerprint, sent in the encrypted `hello` (PLAN.md section 3.2,
 * docs/protocol.md section 5).
 *
 * Each side commits to its own fingerprint before any SDP is sent, and checks the fingerprint in
 * every SDP of the other side against the other side's commitment. Someone in the middle therefore
 * has to choose his certificate for each side before he has seen either real fingerprint, so he
 * cannot search for two certificates that give both sides the same safety code: his chance stays
 * 2^-36 per attempt. Without the commitment, a search of about 2^18 certificates per side was
 * enough (issue #94).
 *
 * No nonce is needed: the fingerprint of a fresh key cannot be guessed. Pure functions only;
 * fingerprints and SDP are never logged.
 */
import { fromBase64Url, toBase64Url } from '@/crypto/base64url';
import { readFingerprintFromSdp, SafetyCodeError } from '@/crypto/safetyCode';

/** Domain separation: this hash is only ever a fingerprint commitment, protocol version 1. */
const FINGERPRINT_COMMITMENT_LABEL = 'secure-call/fp-commit/v1';
/** A full SHA-256 digest, sent as 43 base64url characters. */
export const FINGERPRINT_COMMITMENT_BYTES = 32;

/**
 * SHA-256 over the label, a newline and the normalised fingerprint (`sha-256 AB:CD:…`, as
 * `readFingerprintFromSdp` returns it), as unpadded base64url.
 */
export async function computeFingerprintCommitment(normalisedFingerprint: string): Promise<string> {
  const commitmentInputBytes = new TextEncoder().encode(
    `${FINGERPRINT_COMMITMENT_LABEL}\n${normalisedFingerprint}`,
  );
  const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', commitmentInputBytes));
  return toBase64Url(digestBytes);
}

/** True only for exactly 32 bytes written as canonical unpadded base64url. */
export function isWellFormedFingerprintCommitment(commitmentText: string): boolean {
  const commitmentBytes = fromBase64Url(commitmentText);
  return (
    commitmentBytes !== null &&
    commitmentBytes.length === FINGERPRINT_COMMITMENT_BYTES &&
    toBase64Url(commitmentBytes) === commitmentText
  );
}

/**
 * Whether the one DTLS fingerprint in an SDP is the committed one. False for an SDP with no
 * fingerprint, with several different ones or with a malformed one.
 */
export async function doesSdpMatchFingerprintCommitment(
  sessionDescriptionSdp: string,
  fingerprintCommitment: string,
): Promise<boolean> {
  let fingerprint: string;
  try {
    fingerprint = readFingerprintFromSdp(sessionDescriptionSdp);
  } catch (readError) {
    if (readError instanceof SafetyCodeError) return false;
    throw readError;
  }
  return (await computeFingerprintCommitment(fingerprint)) === fingerprintCommitment;
}
