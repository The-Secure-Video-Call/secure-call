import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ICE_DISCONNECTED_GRACE_PERIOD_MILLISECONDS,
  watchIceConnectionForRestart,
  type IceRestartablePeerConnection,
} from '@/rtc/iceRestart';

function createFixture() {
  const peerConnection = {
    iceConnectionState: 'connected' as RTCIceConnectionState,
    restartIce: vi.fn(),
    oniceconnectionstatechange: null as (() => void) | null,
  };
  const onlineListeners = new Set<() => void>();
  const onlineEventTarget = {
    addEventListener: (_eventName: string, listener: () => void) => onlineListeners.add(listener),
    removeEventListener: (_eventName: string, listener: () => void) =>
      onlineListeners.delete(listener),
  } as unknown as EventTarget;
  const watch = watchIceConnectionForRestart({
    peerConnection: peerConnection as IceRestartablePeerConnection,
    onlineEventTarget,
  });
  function changeIceState(iceConnectionState: RTCIceConnectionState) {
    peerConnection.iceConnectionState = iceConnectionState;
    peerConnection.oniceconnectionstatechange?.();
  }
  return { peerConnection, onlineListeners, watch, changeIceState };
}

describe('ICE restart', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('restarts once after ICE stayed disconnected for 5 s', () => {
    const { peerConnection, changeIceState } = createFixture();
    changeIceState('disconnected');
    vi.advanceTimersByTime(ICE_DISCONNECTED_GRACE_PERIOD_MILLISECONDS - 1);
    expect(peerConnection.restartIce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(peerConnection.restartIce).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(peerConnection.restartIce).toHaveBeenCalledTimes(1);
  });

  it('does not restart when ICE heals within 5 s', () => {
    const { peerConnection, changeIceState } = createFixture();
    changeIceState('disconnected');
    vi.advanceTimersByTime(3000);
    changeIceState('connected');
    vi.advanceTimersByTime(60_000);
    expect(peerConnection.restartIce).not.toHaveBeenCalled();
  });

  it('restarts immediately when ICE failed, and only once', () => {
    const { peerConnection, changeIceState } = createFixture();
    changeIceState('disconnected');
    changeIceState('failed');
    expect(peerConnection.restartIce).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(peerConnection.restartIce).toHaveBeenCalledTimes(1);
  });

  it('negative: stops restarting a dead path after 5 tries, until it connects again', () => {
    const { peerConnection, changeIceState } = createFixture();
    for (let i = 0; i < 20; i += 1) changeIceState('failed');
    expect(peerConnection.restartIce).toHaveBeenCalledTimes(5);
    changeIceState('connected');
    changeIceState('failed');
    expect(peerConnection.restartIce).toHaveBeenCalledTimes(6);
  });

  it('tries a restart when the browser comes back online', () => {
    const { peerConnection, onlineListeners } = createFixture();
    for (const listener of onlineListeners) listener();
    expect(peerConnection.restartIce).toHaveBeenCalledTimes(1);
  });

  it('negative: after stop nothing restarts and the online listener is gone', () => {
    const { peerConnection, onlineListeners, watch, changeIceState } = createFixture();
    changeIceState('disconnected');
    watch.stop();
    vi.advanceTimersByTime(60_000);
    expect(peerConnection.restartIce).not.toHaveBeenCalled();
    expect(onlineListeners.size).toBe(0);
    expect(peerConnection.oniceconnectionstatechange).toBeNull();
  });
});
