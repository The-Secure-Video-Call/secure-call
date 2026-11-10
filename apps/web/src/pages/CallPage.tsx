import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_TITLE } from '@/appTitle';
import { ConnectionQualityIndicator } from '@/components/ConnectionQualityIndicator';
import { SafetyCodeCheck } from '@/components/SafetyCodeCheck';
import type { FingerprintPair } from '@/crypto/safetyCode';
import { tryPlayMediaElement } from '@/media/remoteAudioPlayback';
import { useCameraSwitching } from '@/media/useCameraSwitching';
import { useLocalMediaStream } from '@/media/useLocalMediaStream';
import {
  describeCallConnectionStatusText,
  isPeerConnectionVerified,
} from '@/rtc/callConnectionStatus';
import type { CallSessionEndedReason } from '@/rtc/callSession';
import { useCallSession } from '@/rtc/useCallSession';
import { useConnectionQuality } from '@/rtc/useConnectionQuality';

const ENDED_REASON_TEXT: Record<CallSessionEndedReason, string> = {
  'hung-up': 'The call ended.',
  'room-full': 'This call already has two people, so you cannot join.',
  'room-expired': 'This call link has expired. Start a new call.',
  'reconnect-failed': "Couldn't reconnect. Start a new call.",
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
    reconnectState,
    peerConnectionNumber,
    sessionDescriptionsVersion,
    endedReason,
    hangUp,
    replaceLocalVideoTrack,
    readSessionDescriptionSdps,
    readConnectionStats,
  } = useCallSession(props.roomSecret, localMediaStream);
  const { canSwitchCameras, isSwitchingCamera, switchCameraErrorMessage, switchCamera } =
    useCameraSwitching(localMediaStream, replaceLocalVideoTrack, endedReason !== null);
  const [isTapToStartAudioShown, setIsTapToStartAudioShown] = useState(false);
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
  const connectionQuality = useConnectionQuality(
    callConnectionStatus === 'connected' && endedReason === null,
    readConnectionStats,
  );
  const localVideoRef = useAttachMediaStream(localMediaStream);
  const remoteVideoRef = useAttachMediaStream(remoteMediaStream);

  // Browsers (iOS Safari) may refuse to start the remote audio without a tap: show a button.
  useEffect(() => {
    setIsTapToStartAudioShown(false);
    const remoteVideoElement = remoteVideoRef.current;
    if (remoteMediaStream === null || remoteVideoElement === null) return;
    let isEffectCancelled = false;
    void tryPlayMediaElement(remoteVideoElement).then((playbackState) => {
      if (!isEffectCancelled && playbackState === 'needs-tap') setIsTapToStartAudioShown(true);
    });
    return () => {
      isEffectCancelled = true;
    };
  }, [remoteMediaStream, remoteVideoRef]);

  /** Runs inside the tap, which is the user gesture the browser wants. */
  async function startRemoteAudioFromTap() {
    const remoteVideoElement = remoteVideoRef.current;
    if (remoteVideoElement === null) return;
    const playbackState = await tryPlayMediaElement(remoteVideoElement);
    if (playbackState === 'playing') setIsTapToStartAudioShown(false);
  }

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
        : reconnectState === 'reconnecting'
          ? 'Reconnecting…'
          : reconnectState === 'reconnected' &&
              callConnectionStatus === 'connected' &&
              !isConnectionVerified
            ? 'Reconnected. Compare the safety code again.'
            : describeCallConnectionStatusText(callConnectionStatus, isConnectionVerified);

  return (
    <main className="call-page">
      <h1 className="visually-hidden">{APP_TITLE}</h1>
      <p role="status" className="call-status">
        {statusText}
      </p>
      {connectionQuality !== null && (
        <ConnectionQualityIndicator connectionQuality={connectionQuality} />
      )}
      {mediaErrorMessage !== null && <p role="alert">{mediaErrorMessage}</p>}
      {switchCameraErrorMessage !== null && <p role="alert">{switchCameraErrorMessage}</p>}
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
        {isTapToStartAudioShown && endedReason === null && (
          <button
            type="button"
            className="tap-to-start-audio-button"
            onClick={() => void startRemoteAudioFromTap()}
          >
            Tap to start audio
          </button>
        )}
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
        {canSwitchCameras && (
          <button
            type="button"
            onClick={() => void switchCamera()}
            disabled={isSwitchingCamera || endedReason !== null}
          >
            Switch camera
          </button>
        )}
        <button type="button" className="hang-up-button" onClick={hangUpAndReturnToLobby}>
          {endedReason !== null || mediaErrorMessage !== null ? 'Back to start' : 'Hang up'}
        </button>
      </div>
    </main>
  );
}
