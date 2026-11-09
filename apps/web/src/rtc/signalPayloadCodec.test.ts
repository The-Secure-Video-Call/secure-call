import { describe, expect, it } from 'vitest';
import {
  createSequenceNumberTracker,
  decodeSignalPayload,
  encodeSignalPayload,
} from '@/rtc/signalPayloadCodec';

function base64OfJson(jsonValue: unknown): string {
  return btoa(JSON.stringify(jsonValue));
}

describe('signal payload codec', () => {
  it('round-trips an offer, a candidate and a bye', () => {
    const payloads = [
      { kind: 'offer', data: { type: 'offer', sdp: 'v=0\r\n' }, seq: 0 },
      {
        kind: 'candidate',
        data: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
        seq: 1,
      },
      { kind: 'bye', data: null, seq: 2 },
    ] as const;
    for (const payload of payloads) {
      expect(decodeSignalPayload(encodeSignalPayload(payload))).toEqual(payload);
    }
  });

  it('round-trips non-ASCII text', () => {
    const payload = { kind: 'answer', data: { type: 'answer', sdp: 'é✓' }, seq: 3 } as const;
    expect(decodeSignalPayload(encodeSignalPayload(payload))).toEqual(payload);
  });

  it('rejects text that is not base64, not JSON or not valid UTF-8', () => {
    expect(decodeSignalPayload('***')).toBeNull();
    expect(decodeSignalPayload(btoa('not json'))).toBeNull();
    expect(decodeSignalPayload(btoa('\xff\xfe'))).toBeNull();
  });

  it('rejects unknown kinds, extra fields, mismatched data and bad sequence numbers', () => {
    expect(decodeSignalPayload(base64OfJson({ kind: 'nope', data: null, seq: 0 }))).toBeNull();
    expect(decodeSignalPayload(base64OfJson({ kind: 'bye', data: null, seq: 0, x: 1 }))).toBeNull();
    expect(
      decodeSignalPayload(
        base64OfJson({ kind: 'offer', data: { type: 'answer', sdp: 'x' }, seq: 0 }),
      ),
    ).toBeNull();
    expect(decodeSignalPayload(base64OfJson({ kind: 'bye', data: null, seq: -1 }))).toBeNull();
    expect(decodeSignalPayload(base64OfJson({ kind: 'bye', data: null, seq: 1.5 }))).toBeNull();
  });

  it('refuses to encode an oversized payload', () => {
    const hugeOffer = {
      kind: 'offer',
      data: { type: 'offer', sdp: 'a'.repeat(50000) },
      seq: 0,
    } as const;
    expect(() => encodeSignalPayload(hugeOffer)).toThrow();
  });
});

describe('sequence number tracker', () => {
  it('numbers outgoing payloads from zero', () => {
    const tracker = createSequenceNumberTracker();
    expect(tracker.addSequenceNumber({ kind: 'bye', data: null }).seq).toBe(0);
    expect(tracker.addSequenceNumber({ kind: 'bye', data: null }).seq).toBe(1);
  });

  it('rejects replayed and older incoming sequence numbers', () => {
    const tracker = createSequenceNumberTracker();
    expect(tracker.acceptIncoming(0)).toBe(true);
    expect(tracker.acceptIncoming(0)).toBe(false);
    expect(tracker.acceptIncoming(5)).toBe(true);
    expect(tracker.acceptIncoming(3)).toBe(false);
  });

  it('starts over after reset', () => {
    const tracker = createSequenceNumberTracker();
    tracker.acceptIncoming(4);
    tracker.reset();
    expect(tracker.acceptIncoming(0)).toBe(true);
  });
});
