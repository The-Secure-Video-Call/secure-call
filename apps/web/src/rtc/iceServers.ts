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
