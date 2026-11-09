export const DEFAULT_SIGNALING_URL = 'wss://signal.securevideocall.com/ws/signal/';

/**
 * The signaling server address: `VITE_SIGNALING_URL` when set (local development uses
 * `ws://localhost:8000/ws/signal/`), otherwise the production server. Must be ws:// or wss://.
 */
export function resolveSignalingUrl(configuredSignalingUrl: string | undefined): string {
  if (configuredSignalingUrl === undefined || configuredSignalingUrl === '') {
    return DEFAULT_SIGNALING_URL;
  }
  // Plain ws:// is only for a backend running on this machine; anything else must be wss://.
  const isSecureWebSocket = /^wss:\/\//.test(configuredSignalingUrl);
  const isLocalPlainWebSocket = /^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(
    configuredSignalingUrl,
  );
  if (!isSecureWebSocket && !isLocalPlainWebSocket) {
    throw new Error('VITE_SIGNALING_URL must be wss:// (ws:// only for localhost)');
  }
  return configuredSignalingUrl;
}
