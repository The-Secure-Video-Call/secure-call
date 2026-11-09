import { useCallback, useEffect, useState } from 'react';
import { describeMediaError } from '@/media/mediaErrorMessages';

/**
 * Opens the default camera and microphone for the call and lets the user mute either one.
 * Muting only switches `track.enabled`, so the connection and its negotiation stay untouched.
 * The tracks are stopped when the component unmounts.
 */
export function useLocalMediaStream() {
  const [localMediaStream, setLocalMediaStream] = useState<MediaStream | null>(null);
  const [mediaErrorMessage, setMediaErrorMessage] = useState<string | null>(null);
  const [isMicrophoneMuted, setIsMicrophoneMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);

  useEffect(() => {
    let openedMediaStream: MediaStream | null = null;
    let isEffectCancelled = false;
    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMediaErrorMessage('Your browser does not support camera and microphone access.');
        return;
      }
      try {
        openedMediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (isEffectCancelled) {
          openedMediaStream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
          return;
        }
        setLocalMediaStream(openedMediaStream);
      } catch (mediaError) {
        if (!isEffectCancelled) setMediaErrorMessage(describeMediaError(mediaError));
      }
    })();
    return () => {
      isEffectCancelled = true;
      openedMediaStream?.getTracks().forEach((mediaTrack) => mediaTrack.stop());
    };
  }, []);

  const toggleMicrophoneMuted = useCallback(() => {
    if (localMediaStream === null) return;
    const shouldMute = !isMicrophoneMuted;
    localMediaStream.getAudioTracks().forEach((audioTrack) => (audioTrack.enabled = !shouldMute));
    setIsMicrophoneMuted(shouldMute);
  }, [localMediaStream, isMicrophoneMuted]);

  const toggleCameraOff = useCallback(() => {
    if (localMediaStream === null) return;
    const shouldTurnOff = !isCameraOff;
    localMediaStream
      .getVideoTracks()
      .forEach((videoTrack) => (videoTrack.enabled = !shouldTurnOff));
    setIsCameraOff(shouldTurnOff);
  }, [localMediaStream, isCameraOff]);

  const stopLocalMedia = useCallback(() => {
    localMediaStream?.getTracks().forEach((mediaTrack) => mediaTrack.stop());
  }, [localMediaStream]);

  return {
    localMediaStream,
    mediaErrorMessage,
    isMicrophoneMuted,
    isCameraOff,
    toggleMicrophoneMuted,
    toggleCameraOff,
    stopLocalMedia,
  };
}
