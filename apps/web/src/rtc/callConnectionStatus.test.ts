import { describe, expect, it } from 'vitest';
import { describeCallConnectionStatus } from '@/rtc/callConnectionStatus';

describe('describeCallConnectionStatus', () => {
  it('waits when nobody has arrived', () => {
    expect(describeCallConnectionStatus(null, false)).toBe('waiting-for-other-person');
  });

  it('reports that the other person left once the connection is closed', () => {
    expect(describeCallConnectionStatus(null, true)).toBe('other-person-left');
  });

  it('is connecting for every state except connected', () => {
    for (const state of ['new', 'connecting', 'disconnected', 'failed', 'closed'] as const) {
      expect(describeCallConnectionStatus(state, false)).toBe('connecting');
    }
  });

  it('is connected only for the connected state', () => {
    expect(describeCallConnectionStatus('connected', false)).toBe('connected');
  });
});
