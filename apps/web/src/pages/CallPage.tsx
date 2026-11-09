import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_TITLE } from '@/appTitle';
import { SafetyCodeCheck } from '@/components/SafetyCodeCheck';
import type { FingerprintPair } from '@/crypto/safetyCode';
import { useLocalMediaStream } from '@/media/useLocalMediaStream';
import {
  describeCallConnectionStatusText,
  isPeerConnectionVerified,
} from '@/rtc/callConnectionStatus';
import type { CallSessionEndedReason } from '@/rtc/callSession';
import { useCallSession } from '@/rtc/useCallSession';

const ENDED_REASON_TEXT: Record<CallSessionEndedReason, string> = {
  'hung-up': 'The call ended.',
  'room-full': 'This call already has two people, so you cannot join.',
  'signaling-connection-lost': 'The connection to the server was lost.',
  'invalid-signaling-message': 'The server sent something unexpected, so the call was ended.',
  'message-not-sent': 'The call could not be set up on this device. Start a new call.',
  'message-verification-failed':
    'The connection could not be verified. Someone may be interfering. Start a new call.',
};

/** Shows a MediaStream in a <video> element. */
function useAttachMediaStream(mediaStream: MediaStream | null) {
  const videoElementRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoElementRef.current) videoElementRef.current.srcObject = mediaStream;
  }, [mediaStream]);
  return videoElementRef;
}

/** The call screen: remote and local video, connection status, mute / camera / hang up. */
export function CallPage(props: { roomSecret: Uint8Array; onReturnToLobby(): void }) {
  const {
    localMediaStream,
    mediaErrorMessage,
    isMicrophoneMuted,
    isCameraOff,
    toggleMicrophoneMuted,
    toggleCameraOff,
    stopLocalMedia,
  } = useLocalMediaStream();
  const {
    remoteMediaStream,
    callConnectionStatus,
    peerConnectionNumber,
    sessionDescriptionsVersion,
    endedReason,
    hangUp,
    readSessionDescriptionSdps,
  } = useCallSession(props.roomSecret, localMediaStream);
  // Which peer connection the person pressed Yes for, and the fingerprints the code was made from.
  // A new connection never counts as verified.
  const [verifiedConnection, setVerifiedConnection] = useState<{
    peerConnectionNumber: number;
    fingerprintPair: FingerprintPair;
  } | null>(null);
  const isConnectionVerified = isPeerConnectionVerified(
    verifiedConnection?.peerConnectionNumber ?? null,
    peerConnectionNumber,
  );
  const verifiedFingerprintPair = isConnectionVerified
    ? (verifiedConnection?.fingerprintPair ?? null)
    : null;
  const [didCodesMismatch, setDidCodesMismatch] = useState(false);
  const [wasVerificationImpossible, setWasVerificationImpossible] = useState(false);
  const localVideoRef = useAttachMediaStream(localMediaStream);
  const remoteVideoRef = useAttachMediaStream(remoteMediaStream);

  // A call that ended on its own (room full, connection lost) must not keep the camera running.
  useEffect(() => {
    if (endedReason !== null) stopLocalMedia();
  }, [endedReason, stopLocalMedia]);

  function hangUpAndReturnToLobby() {
    hangUp();
    stopLocalMedia();
    props.onReturnToLobby();
  }

  /** "No": close the peer connection and the socket, and warn. */
  const endCallBecauseCodesDiffer = useCallback(() => {
    setDidCodesMismatch(true);
    hangUp();
  }, [hangUp]);

  /** Fingerprints unreadable: the call cannot be verified, so it is ended (fail closed). */
  const endCallBecauseItCannotBeVerified = useCallback(() => {
    setWasVerificationImpossible(true);
    hangUp();
  }, [hangUp]);

  const statusText =
    endedReason !== null
      ? ENDED_REASON_TEXT[endedReason]
      : localMediaStream === null && mediaErrorMessage === null
        ? 'Starting camera and microphone…'
        : describeCallConnectionStatusText(callConnectionStatus, isConnectionVerified);

  return (
    <main className="call-page">
      <h1 className="visually-hidden">{APP_TITLE}</h1>
      <p role="status" className="call-status">
        {statusText}
      </p>
      {mediaErrorMessage !== null && <p role="alert">{mediaErrorMessage}</p>}
      {didCodesMismatch && (
        <p role="alert" className="safety-code-mismatch">
          The codes didn&apos;t match. Someone may be listening in. The call was ended.
        </p>
      )}
      {wasVerificationImpossible && (
        <p role="alert" className="safety-code-mismatch">
          This call could not be verified, so it was ended.
        </p>
      )}
      {callConnectionStatus === 'connected' && endedReason === null && (
        <SafetyCodeCheck
          key={peerConnectionNumber}
          verifiedFingerprintPair={verifiedFingerprintPair}
          sessionDescriptionsVersion={sessionDescriptionsVersion}
          onCodesMatch={(pressedYesFingerprintPair) =>
            setVerifiedConnection({
              peerConnectionNumber,
              fingerprintPair: pressedYesFingerprintPair,
            })
          }
          readSessionDescriptionSdps={readSessionDescriptionSdps}
          onCodesDoNotMatch={endCallBecauseCodesDiffer}
          onVerifiedPairChanged={endCallBecauseCodesDiffer}
          onVerificationFailed={endCallBecauseItCannotBeVerified}
        />
      )}
      <div className="call-videos">
        <video
          ref={remoteVideoRef}
          className="remote-video"
          autoPlay
          playsInline
          aria-label="The other person"
        />
        <video
          ref={localVideoRef}
          className="local-video"
          autoPlay
          playsInline
          muted
          aria-label="You"
        />
      </div>
      <div className="call-controls">
        <button
          type="button"
          onClick={toggleMicrophoneMuted}
          aria-pressed={isMicrophoneMuted}
          disabled={localMediaStream === null || endedReason !== null}
        >
          {isMicrophoneMuted ? 'Unmute' : 'Mute'}
        </button>
        <button
          type="button"
          onClick={toggleCameraOff}
          aria-pressed={isCameraOff}
          disabled={localMediaStream === null || endedReason !== null}
        >
          {isCameraOff ? 'Camera on' : 'Camera off'}
        </button>
        <button type="button" className="hang-up-button" onClick={hangUpAndReturnToLobby}>
          {endedReason !== null || mediaErrorMessage !== null ? 'Back to start' : 'Hang up'}
        </button>
      </div>
    </main>
  );
}
