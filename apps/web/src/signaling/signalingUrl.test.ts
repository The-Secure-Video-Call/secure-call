import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNALING_URL, resolveSignalingUrl } from '@/signaling/signalingUrl';

describe('resolveSignalingUrl', () => {
  it('falls back to the production server', () => {
    expect(resolveSignalingUrl(undefined)).toBe(DEFAULT_SIGNALING_URL);
    expect(resolveSignalingUrl('')).toBe(DEFAULT_SIGNALING_URL);
  });

  it('accepts a local development address', () => {
    expect(resolveSignalingUrl('ws://localhost:8000/ws/signal/')).toBe(
      'ws://localhost:8000/ws/signal/',
    );
  });

  it('rejects addresses that are not websockets', () => {
    expect(() => resolveSignalingUrl('http://example.com/ws/')).toThrow();
    expect(() => resolveSignalingUrl('javascript:alert(1)')).toThrow();
  });

  it('rejects unencrypted ws:// for non-local hosts', () => {
    expect(() => resolveSignalingUrl('ws://example.com/ws/signal/')).toThrow();
    expect(() => resolveSignalingUrl('ws://localhost.evil.com/ws/signal/')).toThrow();
  });
});
