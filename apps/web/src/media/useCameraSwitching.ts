import { useCallback, useEffect, useRef, useState } from 'react';
import { canSwitchCamera, pickNextCameraDeviceId } from '@/media/cameraSwitching';
import { describeMediaError } from '@/media/mediaErrorMessages';

async function listCameraDeviceIds(): Promise<string[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const mediaDevices = await navigator.mediaDevices.enumerateDevices();
  return mediaDevices
    .filter((mediaDevice) => mediaDevice.kind === 'videoinput' && mediaDevice.deviceId !== '')
    .map((cameraDevice) => cameraDevice.deviceId);
}

/**
 * Lets the person switch between cameras during a call. The new camera's track replaces the old
 * one in the local stream and, through `replaceLocalVideoTrack` (RTCRtpSender.replaceTrack), in
 * the connection, so nothing is renegotiated. `isCameraOff` is kept across the switch.
 * Called from the button's tap, which is also the user gesture mobile browsers want.
 */
export function useCameraSwitching(
  localMediaStream: MediaStream | null,
  replaceLocalVideoTrack: (newVideoTrack: MediaStreamTrack) => Promise<void>,
  /** True once the call has ended: no camera may be started or kept after that. */
  isCallEnded: boolean,
) {
  // True while the call is over or this hook is unmounted (the page left the call).
  const isCallOverRef = useRef(isCallEnded);
  useEffect(() => {
    isCallOverRef.current = isCallEnded;
  }, [isCallEnded]);
  useEffect(() => {
    return () => {
      isCallOverRef.current = true;
    };
  }, []);
  const [cameraDeviceIds, setCameraDeviceIds] = useState<string[]>([]);
  const [isSwitchingCamera, setIsSwitchingCamera] = useState(false);
  const [switchCameraErrorMessage, setSwitchCameraErrorMessage] = useState<string | null>(null);

  // Device IDs are only listed once permission was granted, i.e. when the local stream exists.
  useEffect(() => {
    if (localMediaStream === null || !navigator.mediaDevices?.enumerateDevices) return;
    let isEffectCancelled = false;
    const refreshCameraDeviceIds = () => {
      listCameraDeviceIds().then(
        (listedCameraDeviceIds) => {
          if (!isEffectCancelled) setCameraDeviceIds(listedCameraDeviceIds);
        },
        () => {
          if (!isEffectCancelled) setCameraDeviceIds([]);
        },
      );
    };
    refreshCameraDeviceIds();
    navigator.mediaDevices.addEventListener('devicechange', refreshCameraDeviceIds);
    return () => {
      isEffectCancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', refreshCameraDeviceIds);
    };
  }, [localMediaStream]);

  const switchCamera = useCallback(async () => {
    if (localMediaStream === null || isSwitchingCamera) return;
    const [previousVideoTrack] = localMediaStream.getVideoTracks();
    const previousCameraDeviceId = previousVideoTrack?.getSettings().deviceId ?? null;
    const nextCameraDeviceId = pickNextCameraDeviceId(cameraDeviceIds, previousCameraDeviceId);
    if (previousVideoTrack === undefined || nextCameraDeviceId === null) return;
    setIsSwitchingCamera(true);
    setSwitchCameraErrorMessage(null);
    // Many phones cannot open two cameras at once, so the old one is released first.
    const wasCameraOff = !previousVideoTrack.enabled;
    previousVideoTrack.stop();
    const activeLocalMediaStream = localMediaStream;
    const trackToReplace: MediaStreamTrack = previousVideoTrack;

    /**
     * Opens a camera and puts its track into the connection and the local stream. If the call
     * ended (or the page left) while we were waiting, the new track is stopped at once, so the
     * camera indicator never stays on after the call.
     */
    async function openCameraAndInstallTrack(cameraConstraint: MediaTrackConstraints | true) {
      const newCameraStream = await navigator.mediaDevices.getUserMedia({
        video: cameraConstraint,
      });
      newCameraStream.getAudioTracks().forEach((unexpectedTrack) => unexpectedTrack.stop());
      const newVideoTrack = newCameraStream.getVideoTracks()[0];
      if (newVideoTrack === undefined) throw new Error('no video track');
      try {
        if (isCallOverRef.current) throw new Error('call is over');
        newVideoTrack.enabled = !wasCameraOff;
        await replaceLocalVideoTrack(newVideoTrack);
        if (isCallOverRef.current) throw new Error('call is over');
      } catch (installError) {
        newVideoTrack.stop();
        throw installError;
      }
      activeLocalMediaStream.removeTrack(trackToReplace);
      activeLocalMediaStream.addTrack(newVideoTrack);
    }

    try {
      await openCameraAndInstallTrack({ deviceId: { exact: nextCameraDeviceId } });
    } catch (switchError) {
      if (isCallOverRef.current) return;
      setSwitchCameraErrorMessage(
        `Could not switch camera. ${describeMediaError(switchError)} Try again.`,
      );
      listCameraDeviceIds().then(setCameraDeviceIds, () => {});
      // The old camera was released, so try to get it back; otherwise the call has no video.
      try {
        await openCameraAndInstallTrack(
          previousCameraDeviceId ? { deviceId: { exact: previousCameraDeviceId } } : true,
        );
      } catch {
        // No working camera is left: drop the dead track and say so.
        if (!isCallOverRef.current) {
          activeLocalMediaStream.removeTrack(previousVideoTrack);
          setSwitchCameraErrorMessage('Your camera stopped working. Turn it back on or hang up.');
        }
      }
    } finally {
      if (!isCallOverRef.current) setIsSwitchingCamera(false);
    }
  }, [localMediaStream, cameraDeviceIds, isSwitchingCamera, replaceLocalVideoTrack]);

  return {
    canSwitchCameras: canSwitchCamera(cameraDeviceIds),
    isSwitchingCamera,
    switchCameraErrorMessage,
    switchCamera,
  };
}
