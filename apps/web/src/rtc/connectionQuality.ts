/** Turns two getStats() snapshots into a quality level. Pure; never keeps candidate details. */

export type ConnectionQualityLevel = 'good' | 'fair' | 'poor' | 'unknown';

export type ConnectionQuality = {
  level: ConnectionQualityLevel;
  /** Highest packet loss of incoming audio / video between the snapshots; null if unknown. */
  packetLossPercent: number | null;
  roundTripTimeMilliseconds: number | null;
  isViaRelay: boolean;
};

type InboundCounters = {
  kind: 'audio' | 'video';
  packetsLost: number;
  packetsReceived: number;
};

/** Only numbers and the relay flag are kept from a report: no IP addresses, ports or candidates. */
export type ConnectionStatsSnapshot = {
  /** Cumulative counters per incoming RTP stream, keyed by the stream's stats id. */
  inboundCountersByStreamId: Record<string, InboundCounters>;
  roundTripTimeSeconds: number | null;
  isViaRelay: boolean | null;
};

const GOOD_MAX_LOSS_PERCENT = 2;
const GOOD_MAX_ROUND_TRIP_MILLISECONDS = 150;
const FAIR_MAX_LOSS_PERCENT = 8;
const FAIR_MAX_ROUND_TRIP_MILLISECONDS = 400;

function readFiniteNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Extracts the few numbers needed from a getStats() report (a Map-like of stats objects). */
export function summarizeStatsReport(
  statsReport: { forEach(callback: (stats: unknown) => void): void } | null,
): ConnectionStatsSnapshot {
  const inboundCountersByStreamId: Record<string, InboundCounters> = {};
  const unknownSnapshot: ConnectionStatsSnapshot = {
    inboundCountersByStreamId,
    roundTripTimeSeconds: null,
    isViaRelay: null,
  };
  if (statsReport === null) return unknownSnapshot;

  const allStatsById = new Map<string, Record<string, unknown>>();
  statsReport.forEach((stats) => {
    if (isRecord(stats) && typeof stats.id === 'string') allStatsById.set(stats.id, stats);
  });

  let selectedPair: Record<string, unknown> | null = null;
  for (const stats of allStatsById.values()) {
    if (stats.type === 'transport' && typeof stats.selectedCandidatePairId === 'string') {
      selectedPair = allStatsById.get(stats.selectedCandidatePairId) ?? null;
    }
  }
  if (selectedPair === null) {
    // Browsers without transport.selectedCandidatePairId flag the pair itself.
    for (const stats of allStatsById.values()) {
      if (stats.type === 'candidate-pair' && stats.selected === true) selectedPair = stats;
    }
  }

  let isViaRelay: boolean | null = null;
  let roundTripTimeSeconds: number | null = null;
  if (selectedPair !== null) {
    roundTripTimeSeconds = readFiniteNonNegativeNumber(selectedPair.currentRoundTripTime);
    const localCandidate = allStatsById.get(String(selectedPair.localCandidateId));
    const remoteCandidate = allStatsById.get(String(selectedPair.remoteCandidateId));
    if (localCandidate !== undefined || remoteCandidate !== undefined) {
      isViaRelay =
        localCandidate?.candidateType === 'relay' || remoteCandidate?.candidateType === 'relay';
    }
  }

  for (const stats of allStatsById.values()) {
    if (stats.type !== 'inbound-rtp') continue;
    if (stats.kind !== 'audio' && stats.kind !== 'video') continue;
    const packetsLost = readFiniteNonNegativeNumber(stats.packetsLost);
    const packetsReceived = readFiniteNonNegativeNumber(stats.packetsReceived);
    if (packetsLost === null || packetsReceived === null) continue;
    inboundCountersByStreamId[String(stats.id)] = {
      kind: stats.kind,
      packetsLost,
      packetsReceived,
    };
  }
  return { inboundCountersByStreamId, roundTripTimeSeconds, isViaRelay };
}

/** Loss % between two snapshots for one kind; null if there is nothing usable to compare. */
function calculatePacketLossPercent(
  previousSnapshot: ConnectionStatsSnapshot,
  currentSnapshot: ConnectionStatsSnapshot,
  kind: 'audio' | 'video',
): number | null {
  let lostPacketsDelta = 0;
  let receivedPacketsDelta = 0;
  let hasComparableStream = false;
  for (const [streamId, currentCounters] of Object.entries(
    currentSnapshot.inboundCountersByStreamId,
  )) {
    const previousCounters = previousSnapshot.inboundCountersByStreamId[streamId];
    if (currentCounters.kind !== kind || previousCounters === undefined) continue;
    const streamLostDelta = currentCounters.packetsLost - previousCounters.packetsLost;
    const streamReceivedDelta = currentCounters.packetsReceived - previousCounters.packetsReceived;
    // A counter that went backwards means the stream was reset: skip this interval for it.
    if (streamLostDelta < 0 || streamReceivedDelta < 0) continue;
    lostPacketsDelta += streamLostDelta;
    receivedPacketsDelta += streamReceivedDelta;
    hasComparableStream = true;
  }
  const expectedPacketsDelta = lostPacketsDelta + receivedPacketsDelta;
  if (!hasComparableStream || expectedPacketsDelta === 0) return null;
  return (lostPacketsDelta / expectedPacketsDelta) * 100;
}

export function calculateConnectionQuality(
  previousSnapshot: ConnectionStatsSnapshot,
  currentSnapshot: ConnectionStatsSnapshot,
): ConnectionQuality {
  const audioLossPercent = calculatePacketLossPercent(previousSnapshot, currentSnapshot, 'audio');
  const videoLossPercent = calculatePacketLossPercent(previousSnapshot, currentSnapshot, 'video');
  const knownLossPercents = [audioLossPercent, videoLossPercent].filter(
    (lossPercent): lossPercent is number => lossPercent !== null,
  );
  const packetLossPercent = knownLossPercents.length === 0 ? null : Math.max(...knownLossPercents);
  const roundTripTimeMilliseconds =
    currentSnapshot.roundTripTimeSeconds === null
      ? null
      : currentSnapshot.roundTripTimeSeconds * 1000;
  const isViaRelay = currentSnapshot.isViaRelay === true;

  // Both numbers are needed: a missing one must never look like "Good".
  if (packetLossPercent === null || roundTripTimeMilliseconds === null) {
    return { level: 'unknown', packetLossPercent, roundTripTimeMilliseconds, isViaRelay };
  }
  let level: ConnectionQualityLevel = 'poor';
  if (
    packetLossPercent < GOOD_MAX_LOSS_PERCENT &&
    roundTripTimeMilliseconds < GOOD_MAX_ROUND_TRIP_MILLISECONDS
  ) {
    level = 'good';
  } else if (
    packetLossPercent < FAIR_MAX_LOSS_PERCENT &&
    roundTripTimeMilliseconds < FAIR_MAX_ROUND_TRIP_MILLISECONDS
  ) {
    level = 'fair';
  }
  return { level, packetLossPercent, roundTripTimeMilliseconds, isViaRelay };
}
