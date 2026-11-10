import type { TurnCredentials } from '@protocol/index';

/**
 * Our own coturn answers STUN on the same host and port as TURN. No third party (Google,
 * Cloudflare, ...) may see a user's IP address through ICE.
 */
export const OWN_STUN_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:turn.securevideocall.com:3478' },
];

/**
 * The only TURN URLs we accept from the server's `joined` message: `turn:` or `turns:`, exactly
 * our host, port 3478 or 5349, and optionally `?transport=udp|tcp`. Nothing else: no user info,
 * path, other host, IP address or other port. A hostile signaling server must not be able to point
 * browsers at any other host (LAN addresses included).
 */
const ALLOWED_TURN_URL_PATTERN =
  /^turns?:turn\.securevideocall\.com:(?:3478|5349)(?:\?transport=(?:udp|tcp))?$/;

/**
 * Keeps only the server-sent TURN URLs that point at our own TURN server. Returns undefined when
 * none is left: the TURN entry then counts as missing. The result holds the TURN secret: never
 * log, display or store it.
 */
export function keepOnlyOwnTurnServer(
  turnCredentials: TurnCredentials | undefined,
): TurnCredentials | undefined {
  if (turnCredentials === undefined) return undefined;
  const ownTurnUrls = turnCredentials.urls.filter((turnUrl) =>
    ALLOWED_TURN_URL_PATTERN.test(turnUrl),
  );
  if (ownTurnUrls.length === 0) return undefined;
  return { ...turnCredentials, urls: ownTurnUrls };
}

/**
 * The ICE servers for a peer connection: the server's TURN (when it sent credentials for our own
 * TURN server) plus our own STUN server. The result holds the TURN secret: never log, display or
 * store it.
 */
export function buildIceServers(
  serverSentTurnCredentials: TurnCredentials | undefined,
): RTCIceServer[] {
  const turnCredentials = keepOnlyOwnTurnServer(serverSentTurnCredentials);
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
  serverSentTurnCredentials: TurnCredentials | undefined,
  isPrivacyModeOn: boolean,
): PeerConnectionSettings | null {
  if (!isPrivacyModeOn) {
    return { iceServers: buildIceServers(serverSentTurnCredentials), iceTransportPolicy: 'all' };
  }
  const turnCredentials = keepOnlyOwnTurnServer(serverSentTurnCredentials);
  if (turnCredentials === undefined) return null;
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
