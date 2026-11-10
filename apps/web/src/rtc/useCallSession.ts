import { useCallback, useEffect, useRef, useState } from 'react';
import { deriveRoomId } from '@/crypto/roomId';
import { deriveSignalKey } from '@/crypto/signalKey';
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
export function useCallSession(
  roomSecret: Uint8Array,
  localMediaStream: MediaStream | null,
  isPrivacyModeOn: boolean,
) {
  // Read at every join, so a change applies to the next call or reconnect only.
  const isPrivacyModeOnRef = useRef(isPrivacyModeOn);
  isPrivacyModeOnRef.current = isPrivacyModeOn;
  const [remoteMediaStream, setRemoteMediaStream] = useState<MediaStream | null>(null);
  const [peerConnectionState, setPeerConnectionState] = useState<RTCPeerConnectionState | null>(
    null,
  );
  const [peerConnectionNumber, setPeerConnectionNumber] = useState(0);
  const [sessionDescriptionsVersion, setSessionDescriptionsVersion] = useState(0);
  const [hasOtherPersonLeft, setHasOtherPersonLeft] = useState(false);
  const [endedReason, setEndedReason] = useState<CallSessionEndedReason | null>(null);
  const [reconnectState, setReconnectState] = useState<'none' | 'reconnecting' | 'reconnected'>(
    'none',
  );
  const callSessionRef = useRef<CallSession | null>(null);

  useEffect(() => {
    if (localMediaStream === null) return;
    let isEffectCancelled = false;
    let isPageLeaving = false;
    void (async () => {
      const roomId = await deriveRoomId(roomSecret);
      const signalKey = await deriveSignalKey(roomSecret);
      if (isEffectCancelled) return;
      callSessionRef.current = startCallSession({
        roomId,
        signalKey,
        signalingUrl: resolveSignalingUrl(import.meta.env.VITE_SIGNALING_URL),
        localMediaStream,
        readIsPrivacyModeOn: () => isPrivacyModeOnRef.current,
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
          onSessionDescriptionsMayHaveChanged() {
            if (!isEffectCancelled) setSessionDescriptionsVersion((version) => version + 1);
          },
          onReconnecting() {
            if (isEffectCancelled) return;
            setReconnectState('reconnecting');
            setPeerConnectionState(null);
            setHasOtherPersonLeft(false);
          },
          onReconnected() {
            if (!isEffectCancelled) setReconnectState('reconnected');
          },
          // Problems can contain SDP/ICE details, so they are deliberately not logged.
          onSessionProblem() {},
          onSessionEnded(sessionEndedReason) {
            // Ignore the end of a session this effect already replaced (e.g. StrictMode re-run).
            // Not while the page is going away: ending the session there must not clear the link,
            // or a reload (or restoring the page) would lose it.
            if (!isEffectCancelled && !isPageLeaving) setEndedReason(sessionEndedReason);
          },
        },
      });
    })();
    // Closing the tab skips React's cleanup, so tell the other person we are leaving.
    const hangUpWhenPageIsHidden = () => {
      isPageLeaving = true;
      callSessionRef.current?.hangUp();
    };
    const showPageAgain = (pageShowEvent: PageTransitionEvent) => {
      // Restored from the back/forward cache: the session is gone, so start over with a reload.
      if (pageShowEvent.persisted) window.location.reload();
    };
    window.addEventListener('pageshow', showPageAgain);
    window.addEventListener('pagehide', hangUpWhenPageIsHidden);
    return () => {
      window.removeEventListener('pagehide', hangUpWhenPageIsHidden);
      window.removeEventListener('pageshow', showPageAgain);
      isEffectCancelled = true;
      callSessionRef.current?.hangUp();
      callSessionRef.current = null;
    };
  }, [roomSecret, localMediaStream]);

  const hangUp = useCallback(() => callSessionRef.current?.hangUp(), []);
  const replaceLocalVideoTrack = useCallback(
    (newVideoTrack: MediaStreamTrack) =>
      callSessionRef.current?.replaceLocalVideoTrack(newVideoTrack) ?? Promise.resolve(),
    [],
  );
  const readSessionDescriptionSdps = useCallback(
    () => callSessionRef.current?.readSessionDescriptionSdps() ?? null,
    [],
  );

  const callConnectionStatus: CallConnectionStatus = describeCallConnectionStatus(
    peerConnectionState,
    hasOtherPersonLeft,
  );
  const readConnectionStats = useCallback(
    () => callSessionRef.current?.readConnectionStats() ?? Promise.resolve(null),
    [],
  );
  return {
    readConnectionStats,
    remoteMediaStream,
    callConnectionStatus,
    reconnectState,
    peerConnectionNumber,
    sessionDescriptionsVersion,
    endedReason,
    hangUp,
    replaceLocalVideoTrack,
    readSessionDescriptionSdps,
  };
}
