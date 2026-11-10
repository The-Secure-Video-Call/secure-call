/** How long we keep trying to get back into the room after the signaling connection dropped. */
export const RECONNECT_WINDOW_MILLISECONDS = 120_000;
const RECONNECT_DELAYS_MILLISECONDS = [1_000, 2_000, 4_000, 8_000, 15_000];

/** Waiting time before retry number `retryIndex` (0 = first): 1, 2, 4, 8 s, then 15 s. */
export function getReconnectDelayMilliseconds(retryIndex: number): number {
  const lastIndex = RECONNECT_DELAYS_MILLISECONDS.length - 1;
  return RECONNECT_DELAYS_MILLISECONDS[Math.min(Math.max(retryIndex, 0), lastIndex)]!;
}

export type ReconnectScheduler = {
  readonly isActive: boolean;
  /** The signaling connection dropped: start retrying. Does nothing if already retrying. */
  start(): void;
  /** The last attempt failed (closed, or `room-full` because the server still holds our old connection). */
  scheduleNextAttempt(): void;
  /** Reconnected, hung up or ended: cancel everything. */
  stop(): void;
};

/**
 * Timing only: calls `attemptReconnect` with growing delays until `stop()` or until the window
 * is over, then calls `giveUp` once. It knows nothing about sessions or encryption; the call
 * session starts a completely new join (and a new encrypted session) in every attempt.
 */
export function createReconnectScheduler(schedulerOptions: {
  attemptReconnect(): void;
  giveUp(): void;
}): ReconnectScheduler {
  let isActive = false;
  let nextRetryIndex = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let windowTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (windowTimer !== null) clearTimeout(windowTimer);
    retryTimer = null;
    windowTimer = null;
  }

  function stop(): void {
    isActive = false;
    clearTimers();
  }

  function scheduleNextAttempt(): void {
    if (!isActive) return;
    if (retryTimer !== null) clearTimeout(retryTimer);
    const delay = getReconnectDelayMilliseconds(nextRetryIndex);
    nextRetryIndex += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (isActive) schedulerOptions.attemptReconnect();
    }, delay);
  }

  return {
    get isActive() {
      return isActive;
    },
    start() {
      if (isActive) return;
      isActive = true;
      nextRetryIndex = 0;
      windowTimer = setTimeout(() => {
        stop();
        schedulerOptions.giveUp();
      }, RECONNECT_WINDOW_MILLISECONDS);
      scheduleNextAttempt();
    },
    scheduleNextAttempt,
    stop,
  };
}
