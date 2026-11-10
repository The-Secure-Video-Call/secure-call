import { describe, expect, it } from 'vitest';
import {
  buildIceServers,
  buildPeerConnectionSettings,
  keepOnlyOwnTurnServer,
  OWN_STUN_ICE_SERVERS,
} from '@/rtc/iceServers';

const TURN_CREDENTIALS = {
  urls: [
    'turn:turn.securevideocall.com:3478?transport=udp',
    'turns:turn.securevideocall.com:5349?transport=tcp',
  ],
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

describe('keepOnlyOwnTurnServer', () => {
  function credentialsWithUrls(urls: string[]) {
    return { ...TURN_CREDENTIALS, urls };
  }

  it('keeps our host on port 3478 and 5349, with or without a transport', () => {
    const ownUrls = [
      'turn:turn.securevideocall.com:3478',
      'turn:turn.securevideocall.com:3478?transport=udp',
      'turns:turn.securevideocall.com:5349?transport=tcp',
      'turns:turn.securevideocall.com:3478',
    ];
    expect(keepOnlyOwnTurnServer(credentialsWithUrls(ownUrls))?.urls).toEqual(ownUrls);
  });

  it.each([
    ['another host', 'turn:turn.example.com:3478'],
    ['a LAN IP', 'turn:192.168.1.10:3478'],
    ['a loopback IP', 'turn:127.0.0.1:3478'],
    ['a look-alike host (suffix)', 'turn:turn.securevideocall.com.evil.example:3478'],
    ['a look-alike host (prefix)', 'turn:evilturn.securevideocall.com:3478'],
    ['a sub-domain', 'turn:a.turn.securevideocall.com:3478'],
    ['another scheme (stun)', 'stun:turn.securevideocall.com:3478'],
    ['another scheme (https)', 'https://turn.securevideocall.com:3478'],
    ['a user@host form', 'turn:turn.securevideocall.com@evil.example:3478'],
    ['a user@host form with our host first', 'turn:user@turn.securevideocall.com:3478'],
    ['a path', 'turn:turn.securevideocall.com:3478/path'],
    ['an odd port', 'turn:turn.securevideocall.com:8080'],
    ['a port with extra digits', 'turn:turn.securevideocall.com:34780'],
    ['no port', 'turn:turn.securevideocall.com'],
    ['an unknown query', 'turn:turn.securevideocall.com:3478?x=1'],
    ['upper-case scheme', 'TURN:turn.securevideocall.com:3478'],
    ['a trailing newline', 'turn:turn.securevideocall.com:3478\n'],
  ])('drops %s', (_description, badUrl) => {
    expect(keepOnlyOwnTurnServer(credentialsWithUrls([badUrl]))).toBeUndefined();
  });

  it('drops only the bad URLs and keeps the good ones', () => {
    const result = keepOnlyOwnTurnServer(
      credentialsWithUrls(['turn:192.168.1.10:3478', 'turns:turn.securevideocall.com:5349']),
    );
    expect(result?.urls).toEqual(['turns:turn.securevideocall.com:5349']);
    expect(result?.username).toBe(TURN_CREDENTIALS.username);
  });

  it('returns undefined without credentials', () => {
    expect(keepOnlyOwnTurnServer(undefined)).toBeUndefined();
  });
});

describe('only bad TURN URLs from the server', () => {
  const BAD_TURN_CREDENTIALS = { ...TURN_CREDENTIALS, urls: ['turn:192.168.1.10:3478'] };

  it('normal mode uses only our STUN server and never the bad URL', () => {
    expect(buildPeerConnectionSettings(BAD_TURN_CREDENTIALS, false)).toEqual({
      iceServers: OWN_STUN_ICE_SERVERS,
      iceTransportPolicy: 'all',
    });
  });

  it('privacy mode fails closed: no peer connection settings', () => {
    expect(buildPeerConnectionSettings(BAD_TURN_CREDENTIALS, true)).toBeNull();
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
