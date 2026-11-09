import { useCallback, useEffect, useRef, useState } from 'react';
import { deriveRoomId } from '@/crypto/roomId';
import {
  describeCallConnectionStatus,
  type CallConnectionStatus,
} from '@/rtc/callConnectionStatus';
import { startCallSession, type CallSession, type CallSessionEndedReason } from '@/rtc/callSession';
import { resolveSignalingUrl } from '@/signaling/signalingUrl';

/**
 * Joins the room for `roomSecret` once the local media is ready and reports what the page needs.
 * Only the derived room ID leaves the browser; the secret itself is never passed on or logged.
 */
export function useCallSession(roomSecret: Uint8Array, localMediaStream: MediaStream | null) {
  const [remoteMediaStream, setRemoteMediaStream] = useState<MediaStream | null>(null);
  const [peerConnectionState, setPeerConnectionState] = useState<RTCPeerConnectionState | null>(
    null,
  );
  const [peerConnectionNumber, setPeerConnectionNumber] = useState(0);
  const [hasOtherPersonLeft, setHasOtherPersonLeft] = useState(false);
  const [endedReason, setEndedReason] = useState<CallSessionEndedReason | null>(null);
  const callSessionRef = useRef<CallSession | null>(null);

  useEffect(() => {
    if (localMediaStream === null) return;
    let isEffectCancelled = false;
    void (async () => {
      const roomId = await deriveRoomId(roomSecret);
      if (isEffectCancelled) return;
      callSessionRef.current = startCallSession({
        roomId,
        signalingUrl: resolveSignalingUrl(import.meta.env.VITE_SIGNALING_URL),
        localMediaStream,
        events: {
          onPeerConnectionOpened(newPeerConnectionNumber) {
            if (!isEffectCancelled) setPeerConnectionNumber(newPeerConnectionNumber);
          },
          onRemoteMediaStream(newRemoteMediaStream) {
            if (isEffectCancelled) return;
            setRemoteMediaStream(newRemoteMediaStream);
            if (newRemoteMediaStream === null) {
              setPeerConnectionState(null);
              setHasOtherPersonLeft(true);
            }
          },
          onPeerConnectionStateChange(newPeerConnectionState) {
            if (isEffectCancelled) return;
            setPeerConnectionState(newPeerConnectionState);
            setHasOtherPersonLeft(false);
          },
          // Problems can contain SDP/ICE details, so they are deliberately not logged.
          onSessionProblem() {},
          onSessionEnded(sessionEndedReason) {
            // Ignore the end of a session this effect already replaced (e.g. StrictMode re-run).
            if (!isEffectCancelled) setEndedReason(sessionEndedReason);
          },
        },
      });
    })();
    // Closing the tab skips React's cleanup, so tell the other person we are leaving.
    const hangUpWhenPageIsHidden = () => callSessionRef.current?.hangUp();
    window.addEventListener('pagehide', hangUpWhenPageIsHidden);
    return () => {
      window.removeEventListener('pagehide', hangUpWhenPageIsHidden);
      isEffectCancelled = true;
      callSessionRef.current?.hangUp();
      callSessionRef.current = null;
    };
  }, [roomSecret, localMediaStream]);

  const hangUp = useCallback(() => callSessionRef.current?.hangUp(), []);
  const readSessionDescriptionSdps = useCallback(
    () => callSessionRef.current?.readSessionDescriptionSdps() ?? null,
    [],
  );

  const callConnectionStatus: CallConnectionStatus = describeCallConnectionStatus(
    peerConnectionState,
    hasOtherPersonLeft,
  );
  return {
    remoteMediaStream,
    callConnectionStatus,
    peerConnectionNumber,
    endedReason,
    hangUp,
    readSessionDescriptionSdps,
  };
}
