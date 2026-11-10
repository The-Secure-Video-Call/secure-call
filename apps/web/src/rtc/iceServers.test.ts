import { describe, expect, it } from 'vitest';
import {
  buildIceServers,
  buildPeerConnectionSettings,
  PUBLIC_STUN_ICE_SERVERS,
} from '@/rtc/iceServers';

const TURN_CREDENTIALS = {
  urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp'],
  username: '1700003600:AAECAwQFBgcICQoLDA0ODw',
  credential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

describe('buildIceServers', () => {
  it('gives the TURN server with its credential, plus the public STUN servers', () => {
    expect(buildIceServers(TURN_CREDENTIALS)).toEqual([
      {
        urls: TURN_CREDENTIALS.urls,
        username: TURN_CREDENTIALS.username,
        credential: TURN_CREDENTIALS.credential,
      },
      ...PUBLIC_STUN_ICE_SERVERS,
    ]);
  });

  it('gives only the public STUN servers without TURN credentials', () => {
    expect(buildIceServers(undefined)).toEqual(PUBLIC_STUN_ICE_SERVERS);
  });

  it('does not let the caller change the shared STUN list', () => {
    buildIceServers(undefined).push({ urls: 'stun:evil.example.com:3478' });
    expect(buildIceServers(undefined)).toEqual(PUBLIC_STUN_ICE_SERVERS);
  });
});

describe('buildPeerConnectionSettings', () => {
  it('privacy mode off: all candidates, TURN plus STUN', () => {
    expect(buildPeerConnectionSettings(TURN_CREDENTIALS, false)).toEqual({
      iceServers: buildIceServers(TURN_CREDENTIALS),
      iceTransportPolicy: 'all',
    });
    expect(buildPeerConnectionSettings(undefined, false)).toEqual({
      iceServers: PUBLIC_STUN_ICE_SERVERS,
      iceTransportPolicy: 'all',
    });
  });

  it('privacy mode on: relay policy and only the TURN server, no STUN', () => {
    expect(buildPeerConnectionSettings(TURN_CREDENTIALS, true)).toEqual({
      iceServers: [
        {
          urls: TURN_CREDENTIALS.urls,
          username: TURN_CREDENTIALS.username,
          credential: TURN_CREDENTIALS.credential,
        },
      ],
      iceTransportPolicy: 'relay',
    });
  });

  it('privacy mode on without usable TURN gives nothing to connect with', () => {
    expect(buildPeerConnectionSettings(undefined, true)).toBeNull();
    expect(buildPeerConnectionSettings({ ...TURN_CREDENTIALS, urls: [] }, true)).toBeNull();
  });
});
