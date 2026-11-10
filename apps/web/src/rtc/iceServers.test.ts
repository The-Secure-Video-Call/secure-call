import { describe, expect, it } from 'vitest';
import {
  buildIceServers,
  buildPeerConnectionSettings,
  OWN_STUN_ICE_SERVERS,
} from '@/rtc/iceServers';

const TURN_CREDENTIALS = {
  urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp'],
  username: '1700003600:AAECAwQFBgcICQoLDA0ODw',
  credential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

describe('buildIceServers', () => {
  it('gives the TURN server with its credential, plus our own STUN server', () => {
    expect(buildIceServers(TURN_CREDENTIALS)).toEqual([
      {
        urls: TURN_CREDENTIALS.urls,
        username: TURN_CREDENTIALS.username,
        credential: TURN_CREDENTIALS.credential,
      },
      ...OWN_STUN_ICE_SERVERS,
    ]);
  });

  it('gives only our own STUN server without TURN credentials', () => {
    expect(buildIceServers(undefined)).toEqual([{ urls: 'stun:turn.securevideocall.com:3478' }]);
  });

  it('does not let the caller change the shared STUN list', () => {
    buildIceServers(undefined).push({ urls: 'stun:evil.example.com:3478' });
    expect(buildIceServers(undefined)).toEqual(OWN_STUN_ICE_SERVERS);
  });
});

describe('buildPeerConnectionSettings', () => {
  it('privacy mode off: all candidates, TURN plus our own STUN', () => {
    expect(buildPeerConnectionSettings(TURN_CREDENTIALS, false)).toEqual({
      iceServers: buildIceServers(TURN_CREDENTIALS),
      iceTransportPolicy: 'all',
    });
    expect(buildPeerConnectionSettings(undefined, false)).toEqual({
      iceServers: OWN_STUN_ICE_SERVERS,
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

describe('no third-party ICE servers', () => {
  const THIRD_PARTY_HOST_PATTERN = /google|cloudflare|gstatic/i;

  function collectIceUrls(iceServers: RTCIceServer[]): string[] {
    return iceServers.flatMap((iceServer) =>
      Array.isArray(iceServer.urls) ? iceServer.urls : [iceServer.urls],
    );
  }

  it('never contains a Google or Cloudflare host, with privacy mode on or off', () => {
    for (const turnCredentials of [TURN_CREDENTIALS, undefined]) {
      for (const isPrivacyModeOn of [true, false]) {
        const settings = buildPeerConnectionSettings(turnCredentials, isPrivacyModeOn);
        for (const iceUrl of collectIceUrls(settings?.iceServers ?? [])) {
          expect(iceUrl).not.toMatch(THIRD_PARTY_HOST_PATTERN);
        }
      }
    }
    for (const iceUrl of collectIceUrls(buildIceServers(undefined))) {
      expect(iceUrl).not.toMatch(THIRD_PARTY_HOST_PATTERN);
    }
  });

  it('every stun: URL in every configuration is on our own host', () => {
    for (const turnCredentials of [TURN_CREDENTIALS, undefined]) {
      const settings = buildPeerConnectionSettings(turnCredentials, false);
      const stunUrls = collectIceUrls(settings?.iceServers ?? []).filter((iceUrl) =>
        iceUrl.startsWith('stun:'),
      );
      expect(stunUrls).toEqual(['stun:turn.securevideocall.com:3478']);
    }
  });

  it('privacy mode on has no stun: URL at all', () => {
    const settings = buildPeerConnectionSettings(TURN_CREDENTIALS, true);
    const iceUrls = collectIceUrls(settings?.iceServers ?? []);
    expect(iceUrls.filter((iceUrl) => iceUrl.startsWith('stun:'))).toEqual([]);
  });
});
