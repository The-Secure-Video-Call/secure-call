/**
 * Safety code (PLAN.md section 3.2): both sides hash the two DTLS fingerprints and show the same
 * six symbols. A party in the middle makes the two sides see different fingerprints, so the codes
 * differ. Pure functions only; the SDP is never logged.
 */

export const SAFETY_CODE_LENGTH = 6;
const BITS_PER_INDEX = 6;
const SAFETY_CODE_BYTES_USED = 5; // 36 bits fit in 5 bytes (40 bits); the last 4 bits are dropped
const FINGERPRINT_SEPARATOR = '\n'; // cannot occur inside a normalised fingerprint
const FINGERPRINT_LINE_PREFIX = 'a=fingerprint:';

/** Digest sizes in bytes for the accepted hash names. sha-1 is deliberately not accepted. */
const FINGERPRINT_BYTES_BY_HASH_NAME: ReadonlyMap<string, number> = new Map([
  ['sha-256', 32],
  ['sha-384', 48],
  ['sha-512', 64],
]);

export type SafetyCodeErrorReason =
  'no-fingerprint' | 'several-different-fingerprints' | 'malformed-fingerprint';

/** The fingerprints could not be read, so the call cannot be verified. */
export class SafetyCodeError extends Error {
  readonly reason: SafetyCodeErrorReason;
  constructor(reason: SafetyCodeErrorReason) {
    // The message names only the reason, never SDP content.
    super(`Safety code unavailable: ${reason}`);
    this.name = 'SafetyCodeError';
    this.reason = reason;
  }
}

/**
 * The fixed list of 64 emoji. ORDER IS PART OF THE PROTOCOL: never reorder, insert or replace.
 * All are single code points (no skin tones, no ZWJ sequences, no variation selectors).
 */
export const SAFETY_CODE_EMOJI: readonly { emoji: string; name: string }[] = [
  { emoji: '🐶', name: 'dog' },
  { emoji: '🐱', name: 'cat' },
  { emoji: '🐭', name: 'mouse' },
  { emoji: '🐹', name: 'hamster' },
  { emoji: '🐰', name: 'rabbit' },
  { emoji: '🦊', name: 'fox' },
  { emoji: '🐻', name: 'bear' },
  { emoji: '🐼', name: 'panda' },
  { emoji: '🐨', name: 'koala' },
  { emoji: '🐯', name: 'tiger' },
  { emoji: '🦁', name: 'lion' },
  { emoji: '🐮', name: 'cow' },
  { emoji: '🐷', name: 'pig' },
  { emoji: '🐸', name: 'frog' },
  { emoji: '🐵', name: 'monkey' },
  { emoji: '🐔', name: 'chicken' },
  { emoji: '🐧', name: 'penguin' },
  { emoji: '🦆', name: 'duck' },
  { emoji: '🐢', name: 'turtle' },
  { emoji: '🐙', name: 'octopus' },
  { emoji: '🐬', name: 'dolphin' },
  { emoji: '🐳', name: 'whale' },
  { emoji: '🦋', name: 'butterfly' },
  { emoji: '🐝', name: 'bee' },
  { emoji: '🐞', name: 'ladybug' },
  { emoji: '🐌', name: 'snail' },
  { emoji: '🦉', name: 'owl' },
  { emoji: '🐘', name: 'elephant' },
  { emoji: '🦒', name: 'giraffe' },
  { emoji: '🐴', name: 'horse' },
  { emoji: '🦄', name: 'unicorn' },
  { emoji: '🐊', name: 'crocodile' },
  { emoji: '🍎', name: 'apple' },
  { emoji: '🍌', name: 'banana' },
  { emoji: '🍇', name: 'grapes' },
  { emoji: '🍓', name: 'strawberry' },
  { emoji: '🍒', name: 'cherries' },
  { emoji: '🍋', name: 'lemon' },
  { emoji: '🍉', name: 'watermelon' },
  { emoji: '🍕', name: 'pizza' },
  { emoji: '🍔', name: 'hamburger' },
  { emoji: '🍩', name: 'doughnut' },
  { emoji: '🍪', name: 'cookie' },
  { emoji: '🌽', name: 'corn' },
  { emoji: '🥕', name: 'carrot' },
  { emoji: '🍄', name: 'mushroom' },
  { emoji: '🌵', name: 'cactus' },
  { emoji: '🌲', name: 'tree' },
  { emoji: '🌻', name: 'sunflower' },
  { emoji: '🌈', name: 'rainbow' },
  { emoji: '⭐', name: 'star' },
  { emoji: '🔥', name: 'fire' },
  { emoji: '🌙', name: 'moon' },
  { emoji: '⚽', name: 'soccer ball' },
  { emoji: '🎸', name: 'guitar' },
  { emoji: '🚗', name: 'car' },
  { emoji: '🚀', name: 'rocket' },
  { emoji: '⚓', name: 'anchor' },
  { emoji: '🔑', name: 'key' },
  { emoji: '🔔', name: 'bell' },
  { emoji: '🎈', name: 'balloon' },
  { emoji: '🎁', name: 'gift' },
  { emoji: '👑', name: 'crown' },
  { emoji: '💎', name: 'gem' },
];

/**
 * Reads the one DTLS fingerprint from an SDP, at session or media level, and normalises it to
 * `<hash name lowercase> <HEX UPPERCASE WITH COLONS>`. Throws SafetyCodeError if there is none,
 * if different ones are present, or if any fingerprint line is malformed.
 */
export function readFingerprintFromSdp(sessionDescriptionSdp: string): string {
  const distinctFingerprints = new Set<string>();
  for (const sdpLine of sessionDescriptionSdp.split(/\r\n|\n/)) {
    if (!sdpLine.startsWith(FINGERPRINT_LINE_PREFIX)) continue;
    distinctFingerprints.add(normaliseFingerprint(sdpLine.slice(FINGERPRINT_LINE_PREFIX.length)));
  }
  if (distinctFingerprints.size === 0) throw new SafetyCodeError('no-fingerprint');
  if (distinctFingerprints.size > 1) throw new SafetyCodeError('several-different-fingerprints');
  return [...distinctFingerprints][0] as string;
}

function normaliseFingerprint(fingerprintValue: string): string {
  const fingerprintParts = fingerprintValue.split(' ');
  const [hashName, hexWithColons] = fingerprintParts;
  if (fingerprintParts.length !== 2 || hashName === undefined || hexWithColons === undefined) {
    throw new SafetyCodeError('malformed-fingerprint');
  }
  const normalisedHashName = hashName.toLowerCase();
  const expectedByteCount = FINGERPRINT_BYTES_BY_HASH_NAME.get(normalisedHashName);
  const hexByteStrings = hexWithColons.split(':');
  if (
    expectedByteCount === undefined ||
    hexByteStrings.length !== expectedByteCount ||
    !hexByteStrings.every((hexByteString) => /^[0-9A-Fa-f]{2}$/.test(hexByteString))
  ) {
    throw new SafetyCodeError('malformed-fingerprint');
  }
  return `${normalisedHashName} ${hexWithColons.toUpperCase()}`;
}

/** The normalised fingerprints a safety code is made from. */
export type FingerprintPair = { localFingerprint: string; remoteFingerprint: string };

/** Reads and normalises both fingerprints. Throws SafetyCodeError if either cannot be read. */
export function readFingerprintPair(
  localSessionDescriptionSdp: string,
  remoteSessionDescriptionSdp: string,
): FingerprintPair {
  return {
    localFingerprint: readFingerprintFromSdp(localSessionDescriptionSdp),
    remoteFingerprint: readFingerprintFromSdp(remoteSessionDescriptionSdp),
  };
}

/**
 * The six indices (each 0..63) of the safety code for a pair of fingerprints. Both sides get the
 * same result whichever fingerprint they call local: the pair is sorted before hashing.
 */
export async function computeSafetyCodeIndicesFromFingerprintPair(
  fingerprintPair: FingerprintPair,
): Promise<number[]> {
  const sortedFingerprints = [
    fingerprintPair.localFingerprint,
    fingerprintPair.remoteFingerprint,
  ].sort();
  const hashInputBytes = new TextEncoder().encode(sortedFingerprints.join(FINGERPRINT_SEPARATOR));
  const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', hashInputBytes));
  return extractSixBitIndices(hashBytes.subarray(0, SAFETY_CODE_BYTES_USED));
}

/** The same, straight from the two session descriptions. */
export async function computeSafetyCodeIndices(
  localSessionDescriptionSdp: string,
  remoteSessionDescriptionSdp: string,
): Promise<number[]> {
  return computeSafetyCodeIndicesFromFingerprintPair(
    readFingerprintPair(localSessionDescriptionSdp, remoteSessionDescriptionSdp),
  );
}

/**
 * What to do when the descriptions are read again on a connection:
 * - before the person pressed Yes (`verifiedFingerprintPair` is null): show the code of the
 *   current pair, so the shown code is never stale;
 * - after Yes: the pair must be exactly the one that was verified. Any difference ends the call.
 *   There is no re-verification: a fingerprint change inside one connection is not normal.
 */
export function decideSafetyCodeUpdate(
  verifiedFingerprintPair: FingerprintPair | null,
  currentFingerprintPair: FingerprintPair,
): 'show-current-code' | 'keep-verified' | 'end-call' {
  if (verifiedFingerprintPair === null) return 'show-current-code';
  const isSamePair =
    verifiedFingerprintPair.localFingerprint === currentFingerprintPair.localFingerprint &&
    verifiedFingerprintPair.remoteFingerprint === currentFingerprintPair.remoteFingerprint;
  return isSamePair ? 'keep-verified' : 'end-call';
}

/** Splits the first 36 bits of `firstBytes` (big-endian) into six 6-bit numbers. */
function extractSixBitIndices(firstBytes: Uint8Array): number[] {
  const indices: number[] = [];
  for (let i = 0; i < SAFETY_CODE_LENGTH; i++) {
    let index = 0;
    for (let j = 0; j < BITS_PER_INDEX; j++) {
      const bitPosition = i * BITS_PER_INDEX + j;
      const bitValue = ((firstBytes[bitPosition >> 3] ?? 0) >> (7 - (bitPosition & 7))) & 1;
      index = (index << 1) | bitValue;
    }
    indices.push(index);
  }
  return indices;
}

/** The code as emoji, for display. */
export function safetyCodeIndicesToEmoji(
  safetyCodeIndices: readonly number[],
): { emoji: string; name: string }[] {
  return safetyCodeIndices.map((safetyCodeIndex) => {
    const emojiEntry = SAFETY_CODE_EMOJI[safetyCodeIndex];
    if (emojiEntry === undefined) throw new RangeError('Safety code index out of range');
    return emojiEntry;
  });
}

/** The same code as two-digit numbers (00..63), the accessible alternative. */
export function safetyCodeIndicesToDigits(safetyCodeIndices: readonly number[]): string[] {
  return safetyCodeIndices.map((safetyCodeIndex) => String(safetyCodeIndex).padStart(2, '0'));
}
