import { describe, expect, it } from 'vitest';
import {
  describeCallConnectionStatus,
  describeCallConnectionStatusText,
  isPeerConnectionVerified,
} from '@/rtc/callConnectionStatus';

describe('isPeerConnectionVerified', () => {
  it('is verified only for the connection the person said Yes to', () => {
    expect(isPeerConnectionVerified(1, 1)).toBe(true);
  });

  it('starts unverified for a new connection after someone else joined with the same link', () => {
    expect(isPeerConnectionVerified(1, 2)).toBe(false);
  });

  it('is unverified before anyone pressed Yes', () => {
    expect(isPeerConnectionVerified(null, 1)).toBe(false);
    expect(isPeerConnectionVerified(null, 0)).toBe(false);
  });
});

describe('describeCallConnectionStatusText', () => {
  it('does not call an unverified connection just "Connected"', () => {
    expect(describeCallConnectionStatusText('connected', false)).toBe(
      'Connected, not verified yet',
    );
  });

  it('says verified only once someone pressed Yes', () => {
    expect(describeCallConnectionStatusText('connected', true)).toBe('Connected and verified');
  });

  it('ignores the verified flag when not connected', () => {
    expect(describeCallConnectionStatusText('connecting', true)).toBe('Connecting…');
  });
});

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
