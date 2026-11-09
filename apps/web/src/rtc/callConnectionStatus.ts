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
  connected: 'Connected, not verified yet',
  'other-person-left': 'The other person left the call.',
};

/**
 * "Verified" belongs to exactly one peer connection: it counts only if the person pressed Yes for
 * the connection that exists now. A new connection (someone else joined) starts unverified.
 */
export function isPeerConnectionVerified(
  verifiedPeerConnectionNumber: number | null,
  currentPeerConnectionNumber: number,
): boolean {
  return (
    verifiedPeerConnectionNumber !== null &&
    verifiedPeerConnectionNumber === currentPeerConnectionNumber
  );
}

/** "Connected" alone must not suggest the call is safe: that is said only after someone pressed Yes. */
export function describeCallConnectionStatusText(
  callConnectionStatus: CallConnectionStatus,
  isConnectionVerified: boolean,
): string {
  if (callConnectionStatus === 'connected' && isConnectionVerified) {
    return 'Connected and verified';
  }
  return CALL_CONNECTION_STATUS_TEXT[callConnectionStatus];
}
