import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTION_QUALITY_POLL_INTERVAL_MILLISECONDS,
  startConnectionQualityPolling,
} from '@/rtc/connectionQualityPolling';

function createStatsReportWithAudioPackets(packetsReceived: number) {
  return {
    forEach(callback: (stats: unknown) => void) {
      callback({ id: 'T', type: 'transport', selectedCandidatePairId: 'P' });
      callback({ id: 'P', type: 'candidate-pair', currentRoundTripTime: 0.02 });
      callback({ id: 'A', type: 'inbound-rtp', kind: 'audio', packetsLost: 0, packetsReceived });
    },
  } as unknown as RTCStatsReport;
}

afterEach(() => vi.useRealTimers());

describe('startConnectionQualityPolling', () => {
  it('reports the quality every 2 s after the second read', async () => {
    vi.useFakeTimers();
    let packetsReceived = 0;
    const readConnectionStats = vi.fn(async () => {
      packetsReceived += 100;
      return createStatsReportWithAudioPackets(packetsReceived);
    });
    const onConnectionQuality = vi.fn();
    startConnectionQualityPolling({ readConnectionStats, onConnectionQuality });

    await vi.advanceTimersByTimeAsync(CONNECTION_QUALITY_POLL_INTERVAL_MILLISECONDS);
    expect(onConnectionQuality).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONNECTION_QUALITY_POLL_INTERVAL_MILLISECONDS);
    expect(onConnectionQuality).toHaveBeenCalledTimes(1);
    expect(onConnectionQuality.mock.calls[0]![0]).toMatchObject({ level: 'good' });
  });

  it('clears the timer when stopped (after hang-up) so nothing is read or reported', async () => {
    vi.useFakeTimers();
    const readConnectionStats = vi.fn(async () => createStatsReportWithAudioPackets(1));
    const onConnectionQuality = vi.fn();
    const stopPolling = startConnectionQualityPolling({ readConnectionStats, onConnectionQuality });
    await vi.advanceTimersByTimeAsync(CONNECTION_QUALITY_POLL_INTERVAL_MILLISECONDS);
    stopPolling();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CONNECTION_QUALITY_POLL_INTERVAL_MILLISECONDS * 5);
    expect(readConnectionStats).toHaveBeenCalledTimes(1);
    expect(onConnectionQuality).not.toHaveBeenCalled();
  });

  it('does not report a read that finishes after it was stopped', async () => {
    vi.useFakeTimers();
    const onConnectionQuality = vi.fn();
    let finishRead: (statsReport: RTCStatsReport | null) => void = () => {};
    const stopPolling = startConnectionQualityPolling({
      readConnectionStats: () => new Promise((resolve) => (finishRead = resolve)),
      onConnectionQuality,
    });
    await vi.advanceTimersByTimeAsync(CONNECTION_QUALITY_POLL_INTERVAL_MILLISECONDS);
    stopPolling();
    finishRead(createStatsReportWithAudioPackets(5));
    await vi.advanceTimersByTimeAsync(0);
    expect(onConnectionQuality).not.toHaveBeenCalled();
  });

  it('survives a failed read and reports nothing misleading', async () => {
    vi.useFakeTimers();
    const onConnectionQuality = vi.fn();
    const readConnectionStats = vi.fn(async () => {
      throw new Error('closed');
    });
    startConnectionQualityPolling({ readConnectionStats, onConnectionQuality });
    await vi.advanceTimersByTimeAsync(CONNECTION_QUALITY_POLL_INTERVAL_MILLISECONDS * 3);
    expect(onConnectionQuality).not.toHaveBeenCalled();
  });
});
