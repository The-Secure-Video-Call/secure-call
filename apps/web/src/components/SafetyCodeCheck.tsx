import { useEffect, useState } from 'react';
import {
  computeSafetyCodeIndices,
  safetyCodeIndicesToDigits,
  safetyCodeIndicesToEmoji,
} from '@/crypto/safetyCode';

type SafetyCodeState =
  { kind: 'computing' } | { kind: 'unavailable' } | { kind: 'ready'; safetyCodeIndices: number[] };

/**
 * Shows the safety code of the current connection and asks both people to compare it.
 * Render it only while the connection is `connected`. "No" calls `onCodesDoNotMatch`, which must
 * end the call. The SDP is read once, used for the hash, and never stored or logged.
 */
export function SafetyCodeCheck(props: {
  readSessionDescriptionSdps(): { localSdp: string; remoteSdp: string } | null;
  /** Whether the person already pressed Yes for the current peer connection (owned by the page). */
  isVerified: boolean;
  onCodesMatch(): void;
  onCodesDoNotMatch(): void;
  /** The fingerprints could not be read, so the call cannot be verified; must end the call. */
  onVerificationFailed(): void;
}) {
  const { readSessionDescriptionSdps, onVerificationFailed } = props;
  const [safetyCodeState, setSafetyCodeState] = useState<SafetyCodeState>({ kind: 'computing' });
  const [isShownAsNumbers, setIsShownAsNumbers] = useState(false);

  useEffect(() => {
    let isEffectCancelled = false;
    void (async () => {
      try {
        const sessionDescriptionSdps = readSessionDescriptionSdps();
        if (sessionDescriptionSdps === null) throw new Error('descriptions not set');
        const safetyCodeIndices = await computeSafetyCodeIndices(
          sessionDescriptionSdps.localSdp,
          sessionDescriptionSdps.remoteSdp,
        );
        if (!isEffectCancelled) setSafetyCodeState({ kind: 'ready', safetyCodeIndices });
      } catch {
        // Fail closed. The error object is deliberately ignored: it must never be shown or logged.
        if (!isEffectCancelled) {
          setSafetyCodeState({ kind: 'unavailable' });
          onVerificationFailed();
        }
      }
    })();
    return () => {
      isEffectCancelled = true;
    };
  }, [readSessionDescriptionSdps, onVerificationFailed]);

  if (safetyCodeState.kind === 'computing') {
    return <p role="status">Verifying the call…</p>;
  }

  if (safetyCodeState.kind === 'unavailable') return null; // the page shows why the call ended

  if (props.isVerified) {
    return <p className="safety-code-verified">✔ Verified</p>;
  }

  const { safetyCodeIndices } = safetyCodeState;
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
        <button type="button" onClick={props.onCodesMatch}>
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
