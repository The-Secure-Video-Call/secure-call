export type CallConnectionStatus =
  'waiting-for-other-person' | 'connecting' | 'connected' | 'other-person-left';

/**
 * What to tell the user. `peerConnectionState` is null while there is no connection to the other
 * person (nobody has arrived yet, or the connection was closed).
 */
export function describeCallConnectionStatus(
  peerConnectionState: RTCPeerConnectionState | null,
  hasOtherPersonLeft: boolean,
): CallConnectionStatus {
  if (peerConnectionState === null) {
    return hasOtherPersonLeft ? 'other-person-left' : 'waiting-for-other-person';
  }
  return peerConnectionState === 'connected' ? 'connected' : 'connecting';
}

export const CALL_CONNECTION_STATUS_TEXT: Record<CallConnectionStatus, string> = {
  'waiting-for-other-person': 'Waiting for the other person to join…',
  connecting: 'Connecting…',
  connected: 'Connected',
  'other-person-left': 'The other person left the call.',
};
