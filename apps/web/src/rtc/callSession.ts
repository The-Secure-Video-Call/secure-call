import { startPerfectNegotiation, type NegotiablePeerConnection } from '@/rtc/perfectNegotiation';
import {
  createSequenceNumberTracker,
  decodeSignalPayload,
  encodeSignalPayload,
} from '@/rtc/signalPayloadCodec';
import { connectToSignalingServer, type SignalingClient } from '@/signaling/signalingClient';
import type { SignalPayloadWithoutSequenceNumber } from '@protocol/index';

/**
 * Public STUN only for now; TURN comes in M3.
 * TODO(M3): these third-party servers see the user's IP address; replace with our own coturn.
 */
export const PUBLIC_STUN_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** The part of RTCPeerConnection the call session uses; tests pass a mock. */
export type CallPeerConnection = NegotiablePeerConnection &
  Pick<
    RTCPeerConnection,
    | 'addTrack'
    | 'close'
    | 'connectionState'
    | 'currentLocalDescription'
    | 'currentRemoteDescription'
    | 'ontrack'
    | 'onsignalingstatechange'
    | 'onconnectionstatechange'
  >;

export type CallSessionEndedReason =
  'hung-up' | 'room-full' | 'signaling-connection-lost' | 'invalid-signaling-message';

export type CallSessionEvents = {
  /**
   * A new peer connection was created (the other person arrived). The number grows with every
   * connection, so anything decided about one connection (like "verified") can be tied to it.
   */
  onPeerConnectionOpened(peerConnectionNumber: number): void;
  /** The remote stream, or null when the other person left. */
  onRemoteMediaStream(remoteMediaStream: MediaStream | null): void;
  onPeerConnectionStateChange(peerConnectionState: RTCPeerConnectionState): void;
  /**
   * The connection is `stable` again, so its current descriptions may have changed (for example
   * after a renegotiation). The page reads them again to keep the safety code honest.
   */
  onSessionDescriptionsMayHaveChanged(): void;
  /**
   * Something went wrong with one message or negotiation step; the call itself may continue.
   * The value may contain SDP/ICE details: never log or display it raw.
   */
  onSessionProblem(problem: unknown): void;
  /** The session is over and cannot be reused. */
  onSessionEnded(endedReason: CallSessionEndedReason): void;
};

export type CallSession = {
  hangUp(): void;
  /**
   * The SDP of both descriptions of the current connection, for the safety code; null if there
   * is no connection or negotiation has not set both. Never log or send the returned values.
   */
  readSessionDescriptionSdps(): { localSdp: string; remoteSdp: string } | null;
};

/**
 * Counts peer connections across ALL sessions in this page, never resetting, so a number is never
 * reused when a new session starts and a "verified" decision cannot carry over to it.
 */
let lastPeerConnectionNumber = 0;

/**
 * Joins the room and runs one call: signaling client + one RTCPeerConnection at a time, using
 * perfect negotiation. Roles: `second` joined a room where the other person already is and is the
 * polite peer. Whoever receives `peer-joined` (normally the `first` peer) is impolite and a fresh
 * connection is created for each arrival, so a peer who leaves and rejoins gets a clean start.
 */
export function startCallSession(sessionOptions: {
  roomId: string;
  signalingUrl: string;
  localMediaStream: MediaStream;
  events: CallSessionEvents;
  createPeerConnection?: () => CallPeerConnection;
  connectToSignaling?: typeof connectToSignalingServer;
}): CallSession {
  const { roomId, signalingUrl, localMediaStream, events } = sessionOptions;
  const createPeerConnection =
    sessionOptions.createPeerConnection ??
    (() => new RTCPeerConnection({ iceServers: PUBLIC_STUN_ICE_SERVERS }));
  const connectToSignaling = sessionOptions.connectToSignaling ?? connectToSignalingServer;
  const sequenceNumberTracker = createSequenceNumberTracker();
  let signalingClient: SignalingClient | null = null;
  let hasEnded = false;
  let current: {
    peerConnection: CallPeerConnection;
    negotiation: ReturnType<typeof startPerfectNegotiation>;
  } | null = null;

  function sendPayload(payloadWithoutSequenceNumber: SignalPayloadWithoutSequenceNumber): void {
    try {
      const signalPayload = sequenceNumberTracker.addSequenceNumber(payloadWithoutSequenceNumber);
      signalingClient?.sendSignal(encodeSignalPayload(signalPayload));
    } catch (sendError) {
      events.onSessionProblem(sendError);
    }
  }

  function closePeerConnection(): void {
    if (current === null) return;
    const { peerConnection, negotiation } = current;
    current = null;
    negotiation.stop();
    peerConnection.ontrack = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.onsignalingstatechange = null;
    peerConnection.close();
    events.onRemoteMediaStream(null);
  }

  function openPeerConnection(isPolite: boolean): void {
    closePeerConnection();
    sequenceNumberTracker.reset();
    const peerConnection = createPeerConnection();
    const negotiation = startPerfectNegotiation({
      peerConnection,
      isPolite,
      sendPayload,
      onNegotiationError: events.onSessionProblem,
    });
    current = { peerConnection, negotiation };
    lastPeerConnectionNumber += 1;
    events.onPeerConnectionOpened(lastPeerConnectionNumber);
    peerConnection.ontrack = (trackEvent) => {
      const [remoteMediaStream] = trackEvent.streams;
      if (remoteMediaStream !== undefined) events.onRemoteMediaStream(remoteMediaStream);
    };
    peerConnection.onconnectionstatechange = () => {
      events.onPeerConnectionStateChange(peerConnection.connectionState);
    };
    peerConnection.onsignalingstatechange = () => {
      if (peerConnection.signalingState === 'stable') events.onSessionDescriptionsMayHaveChanged();
    };
    // Adding tracks triggers `negotiationneeded`, which sends the first offer.
    for (const localTrack of localMediaStream.getTracks()) {
      peerConnection.addTrack(localTrack, localMediaStream);
    }
  }

  function endSession(endedReason: CallSessionEndedReason): void {
    if (hasEnded) return;
    hasEnded = true;
    closePeerConnection();
    events.onSessionEnded(endedReason);
  }

  signalingClient = connectToSignaling({
    signalingUrl,
    roomId,
    events: {
      onJoined(role) {
        // `second` arrived after the other person, who is waiting for us: be polite.
        if (role === 'second') openPeerConnection(true);
      },
      onPeerJoined() {
        openPeerConnection(false);
      },
      onPeerLeft() {
        closePeerConnection();
      },
      onSignal(payload, initializationVector) {
        // No encryption in M1, so an iv is unexpected: drop it. Same for anything invalid.
        if (current === null || initializationVector !== null) return;
        const signalPayload = decodeSignalPayload(payload);
        if (signalPayload === null || !sequenceNumberTracker.acceptIncoming(signalPayload.seq)) {
          return;
        }
        if (signalPayload.kind === 'bye') {
          closePeerConnection();
          return;
        }
        void current.negotiation.handleRemotePayload(signalPayload);
      },
      onServerError(errorCode) {
        if (errorCode === 'room-full') endSession('room-full');
        else {
          // rate-limited / bad-message / unsupported-type mean our messages are being dropped,
          // so the call cannot be trusted to finish setting up: end it.
          signalingClient?.leaveAndClose();
          endSession('signaling-connection-lost');
        }
      },
      onClosed(closedReason) {
        if (closedReason === 'invalid-server-message') endSession('invalid-signaling-message');
        else if (closedReason === 'connection-lost') endSession('signaling-connection-lost');
        else endSession('hung-up');
      },
    },
  });

  return {
    readSessionDescriptionSdps() {
      // The "current" descriptions are the ones the connection is really using; a pending offer
      // that is not agreed yet must not feed the safety code.
      const localDescription = current?.peerConnection.currentLocalDescription;
      const remoteDescription = current?.peerConnection.currentRemoteDescription;
      if (!localDescription || !remoteDescription) return null;
      return { localSdp: localDescription.sdp, remoteSdp: remoteDescription.sdp };
    },
    hangUp() {
      if (hasEnded) return;
      if (current !== null) sendPayload({ kind: 'bye', data: null });
      signalingClient?.leaveAndClose();
      endSession('hung-up');
    },
  };
}
