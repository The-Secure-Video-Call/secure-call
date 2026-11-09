import { useEffect, useState } from 'react';
import type { ConnectionQuality } from '@/rtc/connectionQuality';
import { startConnectionQualityPolling } from '@/rtc/connectionQualityPolling';

/** Polls the connection quality while `isPolling`; the timer stops when it turns false or on unmount. */
export function useConnectionQuality(
  isPolling: boolean,
  readConnectionStats: () => Promise<RTCStatsReport | null>,
): ConnectionQuality | null {
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality | null>(null);

  useEffect(() => {
    if (!isPolling) return;
    const stopPolling = startConnectionQualityPolling({
      readConnectionStats,
      onConnectionQuality: setConnectionQuality,
    });
    return () => {
      stopPolling();
      setConnectionQuality(null);
    };
  }, [isPolling, readConnectionStats]);

  return isPolling ? connectionQuality : null;
}
