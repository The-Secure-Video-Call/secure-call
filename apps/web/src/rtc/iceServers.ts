import type { TurnCredentials } from '@protocol/index';

/**
 * Our own coturn answers STUN on the same host and port as TURN. No third party (Google,
 * Cloudflare, ...) may see a user's IP address through ICE.
 */
export const OWN_STUN_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:turn.securevideocall.com:3478' },
];

/**
 * The ICE servers for a peer connection: the server's TURN (when it sent credentials) plus our
 * own STUN server. The result holds the TURN secret: never log, display or store it.
 */
export function buildIceServers(turnCredentials: TurnCredentials | undefined): RTCIceServer[] {
  if (turnCredentials === undefined) return [...OWN_STUN_ICE_SERVERS];
  return [
    {
      urls: [...turnCredentials.urls],
      username: turnCredentials.username,
      credential: turnCredentials.credential,
    },
    ...OWN_STUN_ICE_SERVERS,
  ];
}

/** What a new peer connection is created with. Holds the TURN secret: never log or store it. */
export type PeerConnectionSettings = {
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
};

/**
 * The settings for new peer connections. Without privacy mode: TURN (if any) plus our own STUN,
 * all candidates. With privacy mode: ONLY our TURN server and `iceTransportPolicy: 'relay'` (no
 * STUN either). Returns null when privacy mode is
 * on but there is no usable TURN server: the caller must not connect, and must never fall back to
 * a direct connection.
 */
export function buildPeerConnectionSettings(
  turnCredentials: TurnCredentials | undefined,
  isPrivacyModeOn: boolean,
): PeerConnectionSettings | null {
  if (!isPrivacyModeOn) {
    return { iceServers: buildIceServers(turnCredentials), iceTransportPolicy: 'all' };
  }
  if (turnCredentials === undefined || turnCredentials.urls.length === 0) return null;
  return {
    iceServers: [
      {
        urls: [...turnCredentials.urls],
        username: turnCredentials.username,
        credential: turnCredentials.credential,
      },
    ],
    iceTransportPolicy: 'relay',
  };
}
