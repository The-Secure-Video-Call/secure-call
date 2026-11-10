/** How long ICE may stay `disconnected` before we restart it (short blips often heal alone). */
export const ICE_DISCONNECTED_GRACE_PERIOD_MILLISECONDS = 5_000;

export type IceRestartablePeerConnection = Pick<
  RTCPeerConnection,
  'iceConnectionState' | 'restartIce' | 'oniceconnectionstatechange'
>;

type OnlineEventTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Restarts ICE on the SAME peer connection when the network path breaks: after 5 s of
 * `disconnected`, immediately on `failed`, and when the browser comes back `online`. The restart
 * makes perfect negotiation send a new offer through the existing encrypted session, so session
 * IDs and `seq` simply continue and nothing about the safety-code check changes.
 */
export function watchIceConnectionForRestart(watchOptions: {
  peerConnection: IceRestartablePeerConnection;
  /** Defaults to `window`; tests pass a fake. */
  onlineEventTarget?: OnlineEventTarget | null;
}): { stop(): void } {
  const { peerConnection } = watchOptions;
  const onlineEventTarget =
    watchOptions.onlineEventTarget !== undefined
      ? watchOptions.onlineEventTarget
      : typeof window === 'undefined'
        ? null
        : window;
  let disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  let isStopped = false;

  function clearDisconnectedTimer(): void {
    if (disconnectedTimer !== null) clearTimeout(disconnectedTimer);
    disconnectedTimer = null;
  }

  function restartIce(): void {
    clearDisconnectedTimer();
    if (!isStopped) peerConnection.restartIce();
  }

  peerConnection.oniceconnectionstatechange = () => {
    const iceConnectionState = peerConnection.iceConnectionState;
    if (iceConnectionState === 'failed') restartIce();
    else if (iceConnectionState === 'disconnected') {
      if (disconnectedTimer === null) {
        disconnectedTimer = setTimeout(restartIce, ICE_DISCONNECTED_GRACE_PERIOD_MILLISECONDS);
      }
    } else clearDisconnectedTimer();
  };

  function restartIceBecauseBrowserIsOnline(): void {
    const iceConnectionState = peerConnection.iceConnectionState;
    if (iceConnectionState === 'new' || iceConnectionState === 'closed') return;
    restartIce();
  }
  onlineEventTarget?.addEventListener('online', restartIceBecauseBrowserIsOnline);

  return {
    stop() {
      isStopped = true;
      clearDisconnectedTimer();
      peerConnection.oniceconnectionstatechange = null;
      onlineEventTarget?.removeEventListener('online', restartIceBecauseBrowserIsOnline);
    },
  };
}
