import { describe, expect, it } from 'vitest';
import {
  isRelayCandidateText,
  redactRelatedAddress,
  removeNonRelayCandidateLines,
} from '@/rtc/relayOnlyCandidates';

const HOST = 'candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host generation 0';
const SRFLX =
  'candidate:2 1 udp 1686052607 203.0.113.9 50000 typ srflx raddr 192.168.1.5 rport 50000';
const RELAY = 'candidate:3 1 udp 41885439 198.51.100.7 60000 typ relay raddr 0.0.0.0 rport 0';

describe('isRelayCandidateText', () => {
  it('accepts relay only', () => {
    expect(isRelayCandidateText(RELAY)).toBe(true);
    expect(isRelayCandidateText(HOST)).toBe(false);
    expect(isRelayCandidateText(SRFLX)).toBe(false);
    expect(isRelayCandidateText('candidate:4 1 udp 1 10.0.0.1 1 typ prflx')).toBe(false);
  });

  it('rejects text it cannot read', () => {
    expect(isRelayCandidateText('')).toBe(false);
    expect(isRelayCandidateText('candidate:5 1 udp 1 10.0.0.1 1')).toBe(false);
    expect(isRelayCandidateText('candidate:6 1 udp 1 10.0.0.1 1 typ relayed')).toBe(false);
  });
});

describe('redactRelatedAddress', () => {
  it('hides a real related address and port of a relay candidate', () => {
    expect(
      redactRelatedAddress(
        'candidate:3 1 udp 1 198.51.100.7 6 typ relay raddr 192.168.1.5 rport 5',
      ),
    ).toBe('candidate:3 1 udp 1 198.51.100.7 6 typ relay raddr 0.0.0.0 rport 0');
  });
});

describe('removeNonRelayCandidateLines', () => {
  it('also hides the related address in kept relay lines', () => {
    expect(
      removeNonRelayCandidateLines(
        'a=candidate:3 1 udp 1 1.2.3.4 6 typ relay raddr 10.0.0.2 rport 9',
      ),
    ).toBe('a=candidate:3 1 udp 1 1.2.3.4 6 typ relay raddr 0.0.0.0 rport 0');
  });

  it('keeps relay candidates and all other lines, drops host and srflx', () => {
    const sdp = [
      'v=0',
      'a=ice-ufrag:abc',
      `a=${HOST}`,
      `a=${SRFLX}`,
      `a=${RELAY}`,
      'a=sendrecv',
    ].join('\r\n');
    expect(removeNonRelayCandidateLines(sdp)).toBe(
      ['v=0', 'a=ice-ufrag:abc', `a=${RELAY}`, 'a=sendrecv'].join('\r\n'),
    );
  });
});
