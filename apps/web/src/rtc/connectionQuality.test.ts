import { describe, expect, it } from 'vitest';
import {
  calculateConnectionQuality,
  summarizeStatsReport,
  type ConnectionStatsSnapshot,
} from '@/rtc/connectionQuality';

type StatsObject = Record<string, unknown>;

function createStatsReport(allStats: (StatsObject | null | string)[]) {
  return { forEach: (callback: (stats: unknown) => void) => allStats.forEach(callback) };
}

function createReport(options: {
  audio?: [number, number];
  video?: [number, number];
  roundTripTimeSeconds?: number;
  localCandidateType?: string;
  remoteCandidateType?: string;
}) {
  const allStats: StatsObject[] = [
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
    {
      id: 'P',
      type: 'candidate-pair',
      localCandidateId: 'L',
      remoteCandidateId: 'R',
      currentRoundTripTime: options.roundTripTimeSeconds,
    },
    {
      id: 'L',
      type: 'local-candidate',
      candidateType: options.localCandidateType ?? 'host',
      ip: '192.0.2.1',
    },
    {
      id: 'R',
      type: 'remote-candidate',
      candidateType: options.remoteCandidateType ?? 'srflx',
      ip: '198.51.100.7',
    },
  ];
  if (options.audio) {
    allStats.push({
      id: 'A',
      type: 'inbound-rtp',
      kind: 'audio',
      packetsLost: options.audio[0],
      packetsReceived: options.audio[1],
    });
  }
  if (options.video) {
    allStats.push({
      id: 'V',
      type: 'inbound-rtp',
      kind: 'video',
      packetsLost: options.video[0],
      packetsReceived: options.video[1],
    });
  }
  return summarizeStatsReport(createStatsReport(allStats));
}

/** Two snapshots 2 s apart with the given loss (out of 1000 packets) and round-trip time. */
function qualityFor(lossPer1000: number, roundTripTimeMilliseconds: number) {
  const before = createReport({ audio: [0, 0], video: [0, 0], roundTripTimeSeconds: 0.01 });
  const after = createReport({
    audio: [lossPer1000, 1000 - lossPer1000],
    video: [0, 1000],
    roundTripTimeSeconds: roundTripTimeMilliseconds / 1000,
  });
  return calculateConnectionQuality(before, after);
}

describe('calculateConnectionQuality', () => {
  it('computes loss, round-trip time and relay flag from two snapshots', () => {
    const before = createReport({ audio: [10, 100], video: [0, 200], roundTripTimeSeconds: 0.05 });
    const after = createReport({
      audio: [15, 195],
      video: [10, 390],
      roundTripTimeSeconds: 0.08,
      remoteCandidateType: 'relay',
    });
    const quality = calculateConnectionQuality(before, after);
    expect(quality.packetLossPercent).toBeCloseTo(5, 5); // video: 10 lost of 200; audio: 5 of 100
    expect(quality.roundTripTimeMilliseconds).toBeCloseTo(80, 5);
    expect(quality.isViaRelay).toBe(true);
    expect(quality.level).toBe('fair');
  });

  it('is not via relay when neither candidate is a relay', () => {
    expect(qualityFor(0, 50).isViaRelay).toBe(false);
  });

  it('applies the good / fair / poor boundaries for loss', () => {
    expect(qualityFor(19, 50).level).toBe('good'); // 1.9 %
    expect(qualityFor(20, 50).level).toBe('fair'); // 2 %
    expect(qualityFor(79, 50).level).toBe('fair'); // 7.9 %
    expect(qualityFor(80, 50).level).toBe('poor'); // 8 %
  });

  it('applies the good / fair / poor boundaries for round-trip time', () => {
    expect(qualityFor(0, 149).level).toBe('good');
    expect(qualityFor(0, 150).level).toBe('fair');
    expect(qualityFor(0, 399).level).toBe('fair');
    expect(qualityFor(0, 400).level).toBe('poor');
  });

  it('is unknown, not good, when stats are missing', () => {
    const empty = summarizeStatsReport(createStatsReport([]));
    expect(calculateConnectionQuality(empty, empty).level).toBe('unknown');
    expect(calculateConnectionQuality(empty, summarizeStatsReport(null)).level).toBe('unknown');
    const withoutRoundTripTime = createReport({ audio: [0, 100] });
    const laterWithoutRoundTripTime = createReport({ audio: [0, 200] });
    expect(calculateConnectionQuality(withoutRoundTripTime, laterWithoutRoundTripTime).level).toBe(
      'unknown',
    );
    const withoutPackets = createReport({ roundTripTimeSeconds: 0.01 });
    expect(calculateConnectionQuality(withoutPackets, withoutPackets).level).toBe('unknown');
  });

  it('is unknown when no packets arrived between the snapshots', () => {
    const snapshot = createReport({ audio: [0, 100], roundTripTimeSeconds: 0.01 });
    expect(calculateConnectionQuality(snapshot, snapshot).level).toBe('unknown');
  });

  it('ignores partial or invalid values', () => {
    const invalid = summarizeStatsReport(
      createStatsReport([
        { id: 'A', type: 'inbound-rtp', kind: 'audio', packetsLost: 'x', packetsReceived: 5 },
        { id: 'B', type: 'inbound-rtp', kind: 'audio', packetsLost: NaN, packetsReceived: 5 },
        { id: 'C', type: 'inbound-rtp', kind: 'audio', packetsLost: -1, packetsReceived: 5 },
        null,
        'text',
      ]),
    );
    expect(invalid.inboundCountersByStreamId).toEqual({});
  });

  it('handles counters that go backwards (a reset) without a negative or misleading result', () => {
    const before = createReport({ audio: [500, 5000], roundTripTimeSeconds: 0.01 });
    const afterReset = createReport({ audio: [0, 10], roundTripTimeSeconds: 0.01 });
    expect(calculateConnectionQuality(before, afterReset).level).toBe('unknown');
    expect(calculateConnectionQuality(before, afterReset).packetLossPercent).toBeNull();
  });

  it('uses the selected-flag candidate pair when there is no transport entry', () => {
    const snapshot = summarizeStatsReport(
      createStatsReport([
        {
          id: 'P',
          type: 'candidate-pair',
          selected: true,
          localCandidateId: 'L',
          currentRoundTripTime: 0.2,
        },
        { id: 'L', type: 'local-candidate', candidateType: 'relay' },
      ]),
    );
    expect(snapshot.roundTripTimeSeconds).toBe(0.2);
    expect(snapshot.isViaRelay).toBe(true);
  });

  it('keeps no IP addresses or candidate details in the summary', () => {
    const snapshot: ConnectionStatsSnapshot = createReport({
      audio: [1, 10],
      roundTripTimeSeconds: 0.01,
      localCandidateType: 'relay',
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('192.0.2.1');
    expect(serialized).not.toContain('198.51.100.7');
    expect(serialized).not.toContain('candidate');
  });
});
