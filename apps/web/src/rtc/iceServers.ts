import type { TurnCredentials } from '@protocol/index';

/**
 * TODO(M3): these third-party servers see the user's IP address; replace with our own coturn
 * once it is deployed.
 */
export const PUBLIC_STUN_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * The ICE servers for a peer connection: the server's TURN (when it sent credentials) plus the
 * public STUN servers. The result holds the TURN secret: never log, display or store it.
 */
export function buildIceServers(turnCredentials: TurnCredentials | undefined): RTCIceServer[] {
  if (turnCredentials === undefined) return [...PUBLIC_STUN_ICE_SERVERS];
  return [
    {
      urls: [...turnCredentials.urls],
      username: turnCredentials.username,
      credential: turnCredentials.credential,
    },
    ...PUBLIC_STUN_ICE_SERVERS,
  ];
}

/** What a new peer connection is created with. Holds the TURN secret: never log or store it. */
export type PeerConnectionSettings = {
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
};

/**
 * The settings for new peer connections. Without privacy mode: TURN (if any) plus public STUN,
 * all candidates. With privacy mode: ONLY our TURN server and `iceTransportPolicy: 'relay'` (no
 * STUN either, as a third-party STUN server would see the IP). Returns null when privacy mode is
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
