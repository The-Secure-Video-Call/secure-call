import { useEffect, useRef, useState } from 'react';
import {
  computeSafetyCodeIndicesFromFingerprintPair,
  decideSafetyCodeUpdate,
  readFingerprintPair,
  safetyCodeIndicesToDigits,
  safetyCodeIndicesToEmoji,
  type FingerprintPair,
} from '@/crypto/safetyCode';

type SafetyCodeState =
  | { kind: 'computing' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; fingerprintPair: FingerprintPair; safetyCodeIndices: number[] };

/**
 * Shows the safety code of the current connection and asks both people to compare it.
 * The descriptions are read again every time `sessionDescriptionsVersion` changes:
 * - before Yes, the shown code is recomputed, so it is never stale;
 * - after Yes, the fingerprints must equal the verified pair, otherwise `onVerifiedPairChanged`
 *   must end the call (no re-verification).
 * "No" calls `onCodesDoNotMatch`, which must end the call. The SDP is read, hashed, and never
 * stored or logged.
 */
export function SafetyCodeCheck(props: {
  readSessionDescriptionSdps(): { localSdp: string; remoteSdp: string } | null;
  /** Bumps whenever the connection's descriptions may have changed. */
  sessionDescriptionsVersion: number;
  /**
   * The pair the person pressed Yes for on this peer connection, or null if they did not. Owned by
   * the page, so it survives this component being unmounted while the connection is not connected.
   */
  verifiedFingerprintPair: FingerprintPair | null;
  onCodesMatch(verifiedFingerprintPair: FingerprintPair): void;
  onCodesDoNotMatch(): void;
  /** The fingerprints could not be read, so the call cannot be verified; must end the call. */
  onVerificationFailed(): void;
  /** After Yes the fingerprints changed or can't be read; must end the call like "No". */
  onVerifiedPairChanged(): void;
}) {
  const { readSessionDescriptionSdps, sessionDescriptionsVersion } = props;
  const { onVerificationFailed, onVerifiedPairChanged } = props;
  const [safetyCodeState, setSafetyCodeState] = useState<SafetyCodeState>({ kind: 'computing' });
  const [isShownAsNumbers, setIsShownAsNumbers] = useState(false);
  // Mirrors the prop and is set at the click, so a read that finishes right after Yes is checked.
  const verifiedFingerprintPairRef = useRef(props.verifiedFingerprintPair);

  useEffect(() => {
    let isEffectCancelled = false;
    void (async () => {
      try {
        const sessionDescriptionSdps = readSessionDescriptionSdps();
        if (sessionDescriptionSdps === null) throw new Error('descriptions not set');
        const fingerprintPair = readFingerprintPair(
          sessionDescriptionSdps.localSdp,
          sessionDescriptionSdps.remoteSdp,
        );
        const safetyCodeIndices =
          await computeSafetyCodeIndicesFromFingerprintPair(fingerprintPair);
        if (isEffectCancelled) return;
        const update = decideSafetyCodeUpdate(verifiedFingerprintPairRef.current, fingerprintPair);
        if (update === 'end-call') {
          setSafetyCodeState({ kind: 'unavailable' });
          onVerifiedPairChanged();
        } else {
          setSafetyCodeState({ kind: 'ready', fingerprintPair, safetyCodeIndices });
        }
      } catch {
        // Fail closed. The error object is deliberately ignored: it must never be shown or logged.
        if (isEffectCancelled) return;
        setSafetyCodeState({ kind: 'unavailable' });
        if (verifiedFingerprintPairRef.current !== null) onVerifiedPairChanged();
        else onVerificationFailed();
      }
    })();
    return () => {
      isEffectCancelled = true;
    };
  }, [
    readSessionDescriptionSdps,
    sessionDescriptionsVersion,
    onVerificationFailed,
    onVerifiedPairChanged,
  ]);

  function pressYes(shownFingerprintPair: FingerprintPair) {
    // Read the connection's fingerprints again right now: the shown code may be a render behind a
    // renegotiation. Yes counts only if the connection still uses the pair that was shown.
    try {
      const sessionDescriptionSdps = readSessionDescriptionSdps();
      if (sessionDescriptionSdps === null) throw new Error('descriptions not set');
      const currentFingerprintPair = readFingerprintPair(
        sessionDescriptionSdps.localSdp,
        sessionDescriptionSdps.remoteSdp,
      );
      if (
        decideSafetyCodeUpdate(shownFingerprintPair, currentFingerprintPair) !== 'keep-verified'
      ) {
        throw new Error('fingerprints changed');
      }
    } catch {
      // The error is ignored on purpose: it must never be shown or logged.
      onVerifiedPairChanged();
      return;
    }
    verifiedFingerprintPairRef.current = shownFingerprintPair;
    props.onCodesMatch(shownFingerprintPair);
  }

  if (safetyCodeState.kind === 'computing') {
    return <p role="status">Verifying the call…</p>;
  }

  if (safetyCodeState.kind === 'unavailable') return null; // the page shows why the call ended

  if (props.verifiedFingerprintPair !== null) {
    return <p className="safety-code-verified">✔ Verified</p>;
  }

  const { safetyCodeIndices, fingerprintPair: shownFingerprintPair } = safetyCodeState;
  return (
    <section className="safety-code-check" aria-labelledby="safety-code-question">
      <h2 id="safety-code-question">Do you both see the same code?</h2>
      {isShownAsNumbers ? (
        <p className="safety-code-value" aria-label="Safety code as numbers">
          {safetyCodeIndicesToDigits(safetyCodeIndices).join(' ')}
        </p>
      ) : (
        <p className="safety-code-value" role="img" aria-label={describeEmojiForScreenReader()}>
          {safetyCodeIndicesToEmoji(safetyCodeIndices)
            .map((safetyCodeEmoji) => safetyCodeEmoji.emoji)
            .join(' ')}
        </p>
      )}
      <label>
        <input
          type="checkbox"
          checked={isShownAsNumbers}
          onChange={(changeEvent) => setIsShownAsNumbers(changeEvent.target.checked)}
        />{' '}
        Show as numbers
      </label>
      <p>Read your code out loud to the other person, or ask them to read theirs.</p>
      <div className="safety-code-buttons">
        <button type="button" onClick={() => pressYes(shownFingerprintPair)}>
          Yes, the codes match
        </button>
        <button type="button" className="hang-up-button" onClick={props.onCodesDoNotMatch}>
          No, the codes differ
        </button>
      </div>
    </section>
  );

  function describeEmojiForScreenReader(): string {
    return safetyCodeIndicesToEmoji(safetyCodeIndices)
      .map((safetyCodeEmoji) => safetyCodeEmoji.name)
      .join(', ');
  }
}
