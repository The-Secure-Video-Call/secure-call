import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createReconnectScheduler,
  getReconnectDelayMilliseconds,
  RECONNECT_WINDOW_MILLISECONDS,
} from '@/rtc/reconnect';

describe('reconnect delays', () => {
  it('backs off 1, 2, 4, 8 s and stays at 15 s', () => {
    const delays = [0, 1, 2, 3, 4, 5, 20].map(getReconnectDelayMilliseconds);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });
});

describe('reconnect scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries with growing delays and gives up once after two minutes', () => {
    const attemptReconnect = vi.fn();
    const giveUp = vi.fn();
    const scheduler = createReconnectScheduler({ attemptReconnect, giveUp });
    scheduler.start();
    vi.advanceTimersByTime(999);
    expect(attemptReconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(attemptReconnect).toHaveBeenCalledTimes(1);
    scheduler.scheduleNextAttempt();
    vi.advanceTimersByTime(2000);
    expect(attemptReconnect).toHaveBeenCalledTimes(2);
    // Keep failing until the window is over.
    for (let i = 0; i < 20; i += 1) {
      scheduler.scheduleNextAttempt();
      vi.advanceTimersByTime(15_000);
    }
    expect(giveUp).toHaveBeenCalledTimes(1);
    expect(scheduler.isActive).toBe(false);
    const attemptsAtGiveUp = attemptReconnect.mock.calls.length;
    vi.advanceTimersByTime(RECONNECT_WINDOW_MILLISECONDS);
    expect(attemptReconnect).toHaveBeenCalledTimes(attemptsAtGiveUp);
  });

  it('stop cancels the pending attempt and the window', () => {
    const attemptReconnect = vi.fn();
    const giveUp = vi.fn();
    const scheduler = createReconnectScheduler({ attemptReconnect, giveUp });
    scheduler.start();
    scheduler.stop();
    vi.advanceTimersByTime(RECONNECT_WINDOW_MILLISECONDS * 2);
    expect(attemptReconnect).not.toHaveBeenCalled();
    expect(giveUp).not.toHaveBeenCalled();
  });
});
