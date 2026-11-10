import { startPerfectNegotiation, type NegotiablePeerConnection } from '@/rtc/perfectNegotiation';
import { fromBase64Url, toBase64Url } from '@/crypto/base64url';
import { createSessionId, decideSenderRoles, SESSION_ID_BYTES } from '@/crypto/signalEncryption';
import {
  decryptSignalPayload,
  encryptSignalPayload,
  type SignalAadContext,
} from '@/rtc/signalPayloadCodec';
import { buildIceServers } from '@/rtc/iceServers';
import { connectToSignalingServer, type SignalingClient } from '@/signaling/signalingClient';
import type { SignalPayload, SignalPayloadWithoutSequenceNumber } from '@protocol/index';

/** The part of RTCPeerConnection the call session uses; tests pass a mock. */
export type CallPeerConnection = NegotiablePeerConnection &
  Pick<
    RTCPeerConnection,
    | 'addTrack'
    | 'getSenders'
    | 'close'
    | 'connectionState'
    | 'currentLocalDescription'
    | 'currentRemoteDescription'
    | 'ontrack'
    | 'onsignalingstatechange'
    | 'onconnectionstatechange'
  >;

export type CallSessionEndedReason =
  | 'hung-up'
  | 'room-full'
  /** The call link's time ran out on the server. */
  | 'room-expired'
  | 'signaling-connection-lost'
  | 'invalid-signaling-message'
  /** A signaling message failed decryption or the checks on it: someone may be interfering. */
  | 'message-verification-failed'
  /** Our own hello, offer or answer could not be sent (for example, too large). */
  | 'message-not-sent';

/** Everything that belongs to one peer connection, including its encrypted-signaling state. */
type PeerConnectionState = {
  peerConnection: CallPeerConnection;
  negotiation: ReturnType<typeof startPerfectNegotiation>;
  /** New random ID for this connection only, so recorded messages of earlier ones fail. */
  localSessionId: Uint8Array;
  /** Null until the other side's hello has arrived. */
  peerSessionId: Uint8Array | null;
  nextOutgoingSequenceNumber: number;
  nextIncomingSequenceNumber: number;
  /** Messages are encrypted, sent, decrypted and handled strictly one after the other. */
  outgoingWork: Promise<void>;
  incomingWork: Promise<void>;
};

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
   * Swaps the video track that is being sent (camera switch) with `replaceTrack`, so nothing is
   * renegotiated and the safety code stays valid. A no-op when nobody is connected; the caller
   * also puts the new track into the local stream so a later connection sends it.
   */
  replaceLocalVideoTrack(newVideoTrack: MediaStreamTrack): Promise<void>;
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
  /** Encrypts and authenticates every signaling message (`deriveSignalKey`). */
  signalKey: CryptoKey;
  signalingUrl: string;
  localMediaStream: MediaStream;
  events: CallSessionEvents;
  /** Receives the ICE servers (with TURN credentials, if any): never log or store them. */
  createPeerConnection?: (iceServers: RTCIceServer[]) => CallPeerConnection;
  connectToSignaling?: typeof connectToSignalingServer;
}): CallSession {
  const { roomId, signalKey, signalingUrl, localMediaStream, events } = sessionOptions;
  const createPeerConnection =
    sessionOptions.createPeerConnection ??
    ((iceServers: RTCIceServer[]) => new RTCPeerConnection({ iceServers }));
  const connectToSignaling = sessionOptions.connectToSignaling ?? connectToSignalingServer;
  let signalingClient: SignalingClient | null = null;
  let hasEnded = false;
  let current: PeerConnectionState | null = null;
  /** From our own `joined`, kept in memory only; used for every connection of this session. */
  let iceServers: RTCIceServer[] = buildIceServers(undefined);

  /** AAD fields for messages WE send to the peer; null for a hello. */
  function buildOutgoingAadContext(
    connection: PeerConnectionState,
    isHello: boolean,
  ): SignalAadContext {
    if (isHello) return null;
    if (connection.peerSessionId === null) throw new Error('The other side has not said hello');
    const senderRoles = decideSenderRoles(connection.localSessionId, connection.peerSessionId);
    if (senderRoles === null) throw new Error('Both sides have the same session ID');
    return {
      senderRole: senderRoles.ownRole,
      senderSessionId: connection.localSessionId,
      receiverSessionId: connection.peerSessionId,
    };
  }

  /**
   * Encrypts and sends one payload after the ones queued before it. The sequence number is taken
   * only once the message is really sent, so a message that cannot be sent (too large) leaves no
   * gap that the other side would take for tampering.
   */
  function sendPayload(
    connection: PeerConnectionState,
    payloadWithoutSequenceNumber: SignalPayloadWithoutSequenceNumber,
  ): void {
    connection.outgoingWork = connection.outgoingWork.then(async () => {
      if (current !== connection || hasEnded) return;
      try {
        const signalPayload = {
          ...payloadWithoutSequenceNumber,
          seq: connection.nextOutgoingSequenceNumber,
        } as SignalPayload;
        const encryptedSignal = await encryptSignalPayload({
          signalKey,
          signalPayload,
          aadContext: buildOutgoingAadContext(connection, signalPayload.kind === 'hello'),
        });
        if (current !== connection || hasEnded) return;
        signalingClient?.sendSignal(encryptedSignal.payload, encryptedSignal.iv);
        connection.nextOutgoingSequenceNumber += 1;
      } catch (sendError) {
        events.onSessionProblem(sendError);
        // Without its hello, offer or answer the call can never connect: say so, don't hang.
        // A lost candidate is survivable (others may still work), so only report it.
        if (payloadWithoutSequenceNumber.kind !== 'candidate' && !hasEnded) {
          endSession('message-not-sent');
          signalingClient?.leaveAndClose();
        }
      }
    });
  }

  /**
   * Anything that fails decryption or the checks ends the call at once, never silently: the peer
   * connection and the socket are closed and the page shows the warning.
   */
  function failVerification(): void {
    if (hasEnded) return;
    endSession('message-verification-failed');
    signalingClient?.leaveAndClose();
  }

  /** Handles the one message that must come first: the peer's hello. Returns false to fail. */
  function acceptHello(connection: PeerConnectionState, signalPayload: SignalPayload): boolean {
    if (signalPayload.kind !== 'hello') return false;
    const peerSessionId = fromBase64Url(signalPayload.data.sessionId);
    if (
      peerSessionId === null ||
      peerSessionId.length !== SESSION_ID_BYTES ||
      toBase64Url(peerSessionId) !== signalPayload.data.sessionId ||
      decideSenderRoles(connection.localSessionId, peerSessionId) === null
    ) {
      return false; // malformed, or equal to ours (our own hello reflected back)
    }
    connection.peerSessionId = peerSessionId;
    // Only now, with both IDs known, may anything else be sent: adding tracks starts negotiation.
    for (const localTrack of localMediaStream.getTracks()) {
      connection.peerConnection.addTrack(localTrack, localMediaStream);
    }
    return true;
  }

  function receiveSignal(
    connection: PeerConnectionState,
    payload: string,
    initializationVector: string | null,
  ) {
    connection.incomingWork = connection.incomingWork.then(async () => {
      if (current !== connection || hasEnded) return;
      const expectedSequenceNumber = connection.nextIncomingSequenceNumber;
      const peerSessionId = connection.peerSessionId;
      let aadContext: SignalAadContext = null;
      if (peerSessionId !== null) {
        const senderRoles = decideSenderRoles(connection.localSessionId, peerSessionId);
        if (senderRoles === null) return failVerification();
        aadContext = {
          senderRole: senderRoles.otherRole,
          senderSessionId: peerSessionId,
          receiverSessionId: connection.localSessionId,
        };
      }
      const signalPayload = await decryptSignalPayload({
        signalKey,
        payload,
        iv: initializationVector,
        expectedSequenceNumber,
        aadContext,
      });
      // The peer may have changed while we were decrypting: that message belongs to the old one.
      if (current !== connection || hasEnded) return;
      if (signalPayload === null) return failVerification();
      if (peerSessionId === null) {
        if (!acceptHello(connection, signalPayload)) return failVerification();
      } else if (signalPayload.kind === 'hello') {
        return failVerification();
      } else if (signalPayload.kind === 'bye') {
        closePeerConnection();
      } else {
        void connection.negotiation.handleRemotePayload(signalPayload);
      }
      connection.nextIncomingSequenceNumber = expectedSequenceNumber + 1;
    });
    // If handling a message throws, the queue must not stall silently: end the call.
    connection.incomingWork = connection.incomingWork.catch(() => failVerification());
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
    const peerConnection = createPeerConnection(iceServers);
    const negotiation = startPerfectNegotiation({
      peerConnection,
      isPolite,
      sendPayload: (payloadWithoutSequenceNumber) =>
        sendPayload(connection, payloadWithoutSequenceNumber),
      onNegotiationError: events.onSessionProblem,
    });
    const connection: PeerConnectionState = {
      peerConnection,
      negotiation,
      localSessionId: createSessionId(),
      peerSessionId: null,
      nextOutgoingSequenceNumber: 0,
      nextIncomingSequenceNumber: 0,
      outgoingWork: Promise.resolve(),
      incomingWork: Promise.resolve(),
    };
    current = connection;
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
    // Nothing but our hello goes out until the peer's hello arrives; only then are the tracks
    // added (`acceptHello`), which triggers `negotiationneeded` and sends the first offer.
    sendPayload(connection, {
      kind: 'hello',
      data: { sessionId: toBase64Url(connection.localSessionId) },
    });
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
      onJoined(role, turnCredentials) {
        iceServers = buildIceServers(turnCredentials);
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
        // A signal while nobody is connected is never legitimate (the server relays in order,
        // and `peer-left` comes after the peer's last signal): treat it like any bad message.
        if (current === null) failVerification();
        else receiveSignal(current, payload, initializationVector);
      },
      onServerError(errorCode) {
        if (errorCode === 'room-full') endSession('room-full');
        else if (errorCode === 'room-expired') {
          // End first (closing the socket reports `closed-by-us`, which would win as 'hung-up'),
          // then close the peer connection (done by endSession) and the socket.
          endSession('room-expired');
          signalingClient?.leaveAndClose();
        } else {
          // rate-limited / bad-message / unsupported-type mean our messages are being dropped,
          // so the call cannot be trusted to finish setting up: end it. (End first: closing the
          // socket reports `closed-by-us`, which would otherwise win as 'hung-up'.)
          endSession('signaling-connection-lost');
          signalingClient?.leaveAndClose();
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
    async replaceLocalVideoTrack(newVideoTrack) {
      const videoSenders = (current?.peerConnection.getSenders() ?? []).filter(
        (rtpSender) => rtpSender.track?.kind === 'video',
      );
      await Promise.all(videoSenders.map((videoSender) => videoSender.replaceTrack(newVideoTrack)));
    },
    hangUp() {
      if (hasEnded) return;
      // No `bye` any more: encrypting is asynchronous and the socket closes right now. The
      // server's `leave` makes the other side see `peer-left`, which closes its connection too.
      signalingClient?.leaveAndClose();
      endSession('hung-up');
    },
  };
}
