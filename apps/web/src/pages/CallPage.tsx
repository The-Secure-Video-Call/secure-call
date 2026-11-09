import { useEffect, useRef } from 'react';
import { APP_TITLE } from '@/appTitle';
import { useLocalMediaStream } from '@/media/useLocalMediaStream';
import { CALL_CONNECTION_STATUS_TEXT } from '@/rtc/callConnectionStatus';
import type { CallSessionEndedReason } from '@/rtc/callSession';
import { useCallSession } from '@/rtc/useCallSession';

const ENDED_REASON_TEXT: Record<CallSessionEndedReason, string> = {
  'hung-up': 'The call ended.',
  'room-full': 'This call already has two people, so you cannot join.',
  'signaling-connection-lost': 'The connection to the server was lost.',
  'invalid-signaling-message': 'The server sent something unexpected, so the call was ended.',
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
  const { remoteMediaStream, callConnectionStatus, endedReason, hangUp } = useCallSession(
    props.roomSecret,
    localMediaStream,
  );
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

  const statusText =
    endedReason !== null
      ? ENDED_REASON_TEXT[endedReason]
      : localMediaStream === null && mediaErrorMessage === null
        ? 'Starting camera and microphone…'
        : CALL_CONNECTION_STATUS_TEXT[callConnectionStatus];

  return (
    <main className="call-page">
      <h1 className="visually-hidden">{APP_TITLE}</h1>
      <p role="status" className="call-status">
        {statusText}
      </p>
      {mediaErrorMessage !== null && <p role="alert">{mediaErrorMessage}</p>}
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
