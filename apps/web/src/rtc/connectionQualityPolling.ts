import {
  calculateConnectionQuality,
  summarizeStatsReport,
  type ConnectionQuality,
  type ConnectionStatsSnapshot,
} from '@/rtc/connectionQuality';

export const CONNECTION_QUALITY_POLL_INTERVAL_MILLISECONDS = 2000;

/**
 * Reads the stats every 2 s and reports the quality between each two reads. Returns a function
 * that stops the timer; after it is called nothing more is reported. Stats are never logged.
 */
export function startConnectionQualityPolling(options: {
  readConnectionStats(): Promise<RTCStatsReport | null>;
  onConnectionQuality(connectionQuality: ConnectionQuality): void;
}): () => void {
  let isStopped = false;
  let previousSnapshot: ConnectionStatsSnapshot | null = null;
  let isReadInFlight = false;
  const pollIntervalId = setInterval(() => {
    // A slow read must not pile up or finish out of order: skip this tick instead.
    if (isReadInFlight) return;
    isReadInFlight = true;
    void options.readConnectionStats().then(
      (statsReport) => {
        isReadInFlight = false;
        if (isStopped) return;
        const currentSnapshot = summarizeStatsReport(statsReport);
        if (previousSnapshot !== null) {
          options.onConnectionQuality(
            calculateConnectionQuality(previousSnapshot, currentSnapshot),
          );
        }
        previousSnapshot = currentSnapshot;
      },
      // A failed read counts as "no data", never as a good connection.
      () => {
        isReadInFlight = false;
        if (isStopped) return;
        previousSnapshot = null;
      },
    );
  }, CONNECTION_QUALITY_POLL_INTERVAL_MILLISECONDS);
  return () => {
    isStopped = true;
    clearInterval(pollIntervalId);
  };
}
