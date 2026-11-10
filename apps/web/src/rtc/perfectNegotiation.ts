import { isRelayCandidateText, removeNonRelayCandidateLines } from '@/rtc/relayOnlyCandidates';
import type { SignalPayload, SignalPayloadWithoutSequenceNumber } from '@protocol/index';

/** The part of RTCPeerConnection the negotiation uses; tests pass a mock. */
export type NegotiablePeerConnection = Pick<
  RTCPeerConnection,
  | 'signalingState'
  | 'localDescription'
  | 'setLocalDescription'
  | 'setRemoteDescription'
  | 'addIceCandidate'
> & {
  // Plain function types (no `this`), so a mock object can stand in for the real connection.
  onnegotiationneeded: ((negotiationNeededEvent: Event) => void) | null;
  onicecandidate: ((iceCandidateEvent: RTCPeerConnectionIceEvent) => void) | null;
};

/** Copies the candidate fields that are present (RTCIceCandidateInit rejects explicit undefined). */
function toIceCandidateInit(
  candidateData: Extract<SignalPayload, { kind: 'candidate' }>['data'],
): RTCIceCandidateInit {
  const iceCandidateInit: RTCIceCandidateInit = { candidate: candidateData.candidate };
  if (candidateData.sdpMid !== undefined) iceCandidateInit.sdpMid = candidateData.sdpMid;
  if (candidateData.sdpMLineIndex !== undefined) {
    iceCandidateInit.sdpMLineIndex = candidateData.sdpMLineIndex;
  }
  if (candidateData.usernameFragment !== undefined) {
    iceCandidateInit.usernameFragment = candidateData.usernameFragment;
  }
  return iceCandidateInit;
}

/**
 * The "perfect negotiation" pattern (MDN / W3C WebRTC spec). Both sides run the same code; when
 * both offer at once, the polite peer rolls back and accepts the other's offer while the
 * impolite peer ignores it. `handleRemotePayload` calls are processed one at a time, in order.
 */
export function startPerfectNegotiation(negotiationOptions: {
  peerConnection: NegotiablePeerConnection;
  isPolite: boolean;
  sendPayload(payloadWithoutSequenceNumber: SignalPayloadWithoutSequenceNumber): void;
  onNegotiationError(negotiationError: unknown): void;
  /**
   * Privacy mode: never send a local candidate whose type is not `relay`, neither as a candidate
   * message nor inside an offer or answer.
   */
  sendOnlyRelayCandidates?: boolean;
}) {
  const { peerConnection, isPolite, sendPayload, onNegotiationError } = negotiationOptions;
  const sendOnlyRelayCandidates = negotiationOptions.sendOnlyRelayCandidates === true;
  const prepareSdpForSending = (sdp: string) =>
    sendOnlyRelayCandidates ? removeNonRelayCandidateLines(sdp) : sdp;
  let isMakingOffer = false;
  let isIgnoringOffer = false;
  let isStopped = false;
  let pendingWork: Promise<void> = Promise.resolve();

  peerConnection.onnegotiationneeded = async () => {
    try {
      isMakingOffer = true;
      await peerConnection.setLocalDescription();
      const localDescription = peerConnection.localDescription;
      if (!isStopped && localDescription?.type === 'offer') {
        sendPayload({
          kind: 'offer',
          data: { type: 'offer', sdp: prepareSdpForSending(localDescription.sdp) },
        });
      }
    } catch (negotiationError) {
      if (!isStopped) onNegotiationError(negotiationError);
    } finally {
      isMakingOffer = false;
    }
  };

  peerConnection.onicecandidate = (iceCandidateEvent) => {
    const iceCandidate = iceCandidateEvent.candidate;
    if (isStopped || iceCandidate === null) return;
    if (sendOnlyRelayCandidates && !isRelayCandidateText(iceCandidate.candidate)) return;
    sendPayload({
      kind: 'candidate',
      data: {
        candidate: iceCandidate.candidate,
        sdpMid: iceCandidate.sdpMid,
        sdpMLineIndex: iceCandidate.sdpMLineIndex,
        usernameFragment: iceCandidate.usernameFragment,
      },
    });
  };

  async function applyRemotePayload(remotePayload: SignalPayload): Promise<void> {
    if (remotePayload.kind === 'candidate') {
      try {
        await peerConnection.addIceCandidate(toIceCandidateInit(remotePayload.data));
      } catch (candidateError) {
        // Candidates that belong to an offer we deliberately ignored are expected to fail.
        if (!isIgnoringOffer) throw candidateError;
      }
      return;
    }
    if (remotePayload.kind === 'offer' || remotePayload.kind === 'answer') {
      const isOfferCollision =
        remotePayload.kind === 'offer' &&
        (isMakingOffer || peerConnection.signalingState !== 'stable');
      isIgnoringOffer = !isPolite && isOfferCollision;
      if (isIgnoringOffer) return;
      await peerConnection.setRemoteDescription(remotePayload.data);
      if (remotePayload.kind === 'offer') {
        await peerConnection.setLocalDescription();
        const localDescription = peerConnection.localDescription;
        if (!isStopped && localDescription?.type === 'answer') {
          sendPayload({
            kind: 'answer',
            data: { type: 'answer', sdp: prepareSdpForSending(localDescription.sdp) },
          });
        }
      }
    }
    // `hello` and `bye` are handled by the call session, not here.
  }

  return {
    handleRemotePayload(remotePayload: SignalPayload): Promise<void> {
      pendingWork = pendingWork.then(async () => {
        if (isStopped) return;
        try {
          await applyRemotePayload(remotePayload);
        } catch (negotiationError) {
          if (!isStopped) onNegotiationError(negotiationError);
        }
      });
      return pendingWork;
    },
    stop(): void {
      isStopped = true;
      peerConnection.onnegotiationneeded = null;
      peerConnection.onicecandidate = null;
    },
  };
}
