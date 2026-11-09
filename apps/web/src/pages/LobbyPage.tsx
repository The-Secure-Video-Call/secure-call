import { useCallback, useState } from 'react';
import { APP_TITLE } from '@/appTitle';
import { buildCallLink } from '@/crypto/callLink';
import { encodeSecret, generateSecret } from '@/crypto/secret';
import { useCameraAndMicrophonePreview } from '@/media/useCameraAndMicrophonePreview';

/** The start page: create a call link, preview camera and microphone, pick devices. */
export function LobbyPage() {
  const [selectedCameraDeviceId, setSelectedCameraDeviceId] = useState('');
  const [selectedMicrophoneDeviceId, setSelectedMicrophoneDeviceId] = useState('');
  const [callLink, setCallLink] = useState<string | null>(null);
  const [isCallLinkCopied, setIsCallLinkCopied] = useState(false);
  const { previewVideoRef, mediaErrorMessage, availableMediaDevices } =
    useCameraAndMicrophonePreview(selectedCameraDeviceId, selectedMicrophoneDeviceId);

  const cameraDevices = availableMediaDevices.filter(
    (mediaDevice) => mediaDevice.kind === 'videoinput',
  );
  const microphoneDevices = availableMediaDevices.filter(
    (mediaDevice) => mediaDevice.kind === 'audioinput',
  );

  const createNewCallLink = useCallback(() => {
    setCallLink(buildCallLink(window.location.origin, encodeSecret(generateSecret())));
    setIsCallLinkCopied(false);
  }, []);

  const copyCallLinkToClipboard = useCallback(async () => {
    if (!callLink) return;
    try {
      await navigator.clipboard.writeText(callLink);
      setIsCallLinkCopied(true);
    } catch {
      setIsCallLinkCopied(false);
    }
  }, [callLink]);

  return (
    <main>
      <h1>{APP_TITLE}</h1>
      <video
        ref={previewVideoRef}
        autoPlay
        playsInline
        muted
        aria-label="Camera preview"
        width={480}
      />
      {mediaErrorMessage && <p role="alert">{mediaErrorMessage}</p>}
      <label>
        Camera
        <select
          value={selectedCameraDeviceId}
          onChange={(changeEvent) => setSelectedCameraDeviceId(changeEvent.target.value)}
        >
          <option value="">Default</option>
          {cameraDevices.map((cameraDevice, cameraIndex) => (
            <option key={cameraDevice.deviceId} value={cameraDevice.deviceId}>
              {cameraDevice.label || `Camera ${cameraIndex + 1}`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Microphone
        <select
          value={selectedMicrophoneDeviceId}
          onChange={(changeEvent) => setSelectedMicrophoneDeviceId(changeEvent.target.value)}
        >
          <option value="">Default</option>
          {microphoneDevices.map((microphoneDevice, microphoneIndex) => (
            <option key={microphoneDevice.deviceId} value={microphoneDevice.deviceId}>
              {microphoneDevice.label || `Microphone ${microphoneIndex + 1}`}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={createNewCallLink}>
        New call
      </button>
      {callLink && (
        <div>
          <input
            readOnly
            value={callLink}
            aria-label="Call link"
            onFocus={(focusEvent) => focusEvent.target.select()}
          />
          <button type="button" onClick={() => void copyCallLinkToClipboard()}>
            {isCallLinkCopied ? 'Copied' : 'Copy link'}
          </button>
          <p>Share this link only with the person you want to call.</p>
        </div>
      )}
    </main>
  );
}
