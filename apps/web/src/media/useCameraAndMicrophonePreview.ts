import { useEffect, useRef, useState } from 'react';
import { describeMediaError } from '@/media/mediaErrorMessages';

/**
 * Shows the chosen camera in a <video> element and lists the available devices.
 * An empty device ID means "the browser's default device".
 */
export function useCameraAndMicrophonePreview(
  selectedCameraDeviceId: string,
  selectedMicrophoneDeviceId: string,
) {
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const [mediaErrorMessage, setMediaErrorMessage] = useState<string | null>(null);
  const [availableMediaDevices, setAvailableMediaDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    let previewStream: MediaStream | null = null;
    let isEffectCancelled = false;
    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMediaErrorMessage('Your browser does not support camera and microphone access.');
        return;
      }
      try {
        previewStream = await navigator.mediaDevices.getUserMedia({
          video: selectedCameraDeviceId ? { deviceId: { exact: selectedCameraDeviceId } } : true,
          audio: selectedMicrophoneDeviceId
            ? { deviceId: { exact: selectedMicrophoneDeviceId } }
            : true,
        });
        if (isEffectCancelled) {
          previewStream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
          return;
        }
        setMediaErrorMessage(null);
        if (previewVideoRef.current) previewVideoRef.current.srcObject = previewStream;
        // Device labels are only available after permission is granted.
        setAvailableMediaDevices(await navigator.mediaDevices.enumerateDevices());
      } catch (mediaError) {
        if (!isEffectCancelled) setMediaErrorMessage(describeMediaError(mediaError));
      }
    })();
    return () => {
      isEffectCancelled = true;
      previewStream?.getTracks().forEach((mediaTrack) => mediaTrack.stop());
    };
  }, [selectedCameraDeviceId, selectedMicrophoneDeviceId]);

  return { previewVideoRef, mediaErrorMessage, availableMediaDevices };
}
