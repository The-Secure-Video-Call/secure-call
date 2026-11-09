import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeSecret, generateSecret } from '../crypto/secret';
import { buildCallLink, describeMediaError } from './media';

function useMediaPreview(cameraId: string, micId: string) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Your browser does not support camera and microphone access.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: cameraId ? { deviceId: { exact: cameraId } } : true,
          audio: micId ? { deviceId: { exact: micId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        setError(null);
        if (videoRef.current) videoRef.current.srcObject = stream;
        // Labels are only available after permission is granted.
        setDevices(await navigator.mediaDevices.enumerateDevices());
      } catch (err) {
        if (!cancelled) setError(describeMediaError(err));
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [cameraId, micId]);

  return { videoRef, error, devices };
}

export function Lobby() {
  const [cameraId, setCameraId] = useState('');
  const [micId, setMicId] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { videoRef, error, devices } = useMediaPreview(cameraId, micId);

  const cameras = devices.filter((d) => d.kind === 'videoinput');
  const mics = devices.filter((d) => d.kind === 'audioinput');

  const newCall = useCallback(() => {
    setLink(buildCallLink(window.location.origin, encodeSecret(generateSecret())));
    setCopied(false);
  }, []);

  const copy = useCallback(async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [link]);

  return (
    <main>
      <h1>Secure Call</h1>
      <video ref={videoRef} autoPlay playsInline muted aria-label="Camera preview" width={480} />
      {error && <p role="alert">{error}</p>}
      <label>
        Camera
        <select value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
          <option value="">Default</option>
          {cameras.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Camera ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Microphone
        <select value={micId} onChange={(e) => setMicId(e.target.value)}>
          <option value="">Default</option>
          {mics.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Microphone ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={newCall}>
        New call
      </button>
      {link && (
        <div>
          <input readOnly value={link} aria-label="Call link" onFocus={(e) => e.target.select()} />
          <button type="button" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <p>Share this link only with the person you want to call.</p>
        </div>
      )}
    </main>
  );
}
