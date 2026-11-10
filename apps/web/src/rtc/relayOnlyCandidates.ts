/** Matches the candidate type in the SDP candidate line: `... typ relay raddr ...`. */
const CANDIDATE_TYPE_PATTERN = /(?:^|\s)typ\s+([a-z]+)(?:\s|$)/;

/**
 * True only for a candidate that is clearly of type `relay`. Anything else, including a line that
 * cannot be read, counts as not relay (fail closed), so it is never sent in privacy mode.
 */
export function isRelayCandidateText(candidateText: string): boolean {
  return CANDIDATE_TYPE_PATTERN.exec(candidateText)?.[1] === 'relay';
}

/**
 * Removes every `a=candidate:` line that is not a relay candidate from an SDP. The browser already
 * gathers only relay candidates in privacy mode (`iceTransportPolicy: 'relay'`); this is the second
 * line of defence for candidates that are written into the SDP itself.
 */
export function removeNonRelayCandidateLines(sessionDescriptionSdp: string): string {
  return sessionDescriptionSdp
    .split(/\r?\n/)
    .filter((sdpLine) => !sdpLine.startsWith('a=candidate:') || isRelayCandidateText(sdpLine))
    .join('\r\n');
}
