import { watchIceConnectionForRestart } from '@/rtc/iceRestart';
import { startPerfectNegotiation, type NegotiablePeerConnection } from '@/rtc/perfectNegotiation';
import { createReconnectScheduler } from '@/rtc/reconnect';
import { fromBase64Url, toBase64Url } from '@/crypto/base64url';
import {
  isWellFormedFingerprintCommitment,
  readCommittedFingerprint,
} from '@/crypto/fingerprintCommitment';
import { readFingerprintFromSdp, SafetyCodeError } from '@/crypto/safetyCode';
import { createSessionId, decideSenderRoles, SESSION_ID_BYTES } from '@/crypto/signalEncryption';
import { prepareLocalCertificate, type LocalCertificate } from '@/rtc/localCertificate';
import {
  decryptSignalPayload,
  encryptSignalPayload,
  type SignalAadContext,
} from '@/rtc/signalPayloadCodec';
import { buildPeerConnectionSettings, type PeerConnectionSettings } from '@/rtc/iceServers';
import { connectToSignalingServer, type SignalingClient } from '@/signaling/signalingClient';
import type {
  SignalPayload,
  SignalPayloadWithoutSequenceNumber,
  TurnCredentials,
} from '@protocol/index';

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
    | 'getStats'
    | 'ontrack'
    | 'onsignalingstatechange'
    | 'onconnectionstatechange'
    | 'iceConnectionState'
    | 'oniceconnectionstatechange'
    | 'restartIce'
  >;

export type CallSessionEndedReason =
  | 'hung-up'
  | 'room-full'
  /** The call link's time ran out on the server. */
  | 'room-expired'
  | 'signaling-connection-lost'
  /** The signaling connection dropped mid-call and could not be restored within the window. */
  | 'reconnect-failed'
  | 'invalid-signaling-message'
  /** A signaling message failed decryption or the checks on it: someone may be interfering. */
  | 'message-verification-failed'
  /**
   * Our own hello, offer or answer could not be prepared or sent (for example, too large, or the
   * certificate for the connection could not be made).
   */
  | 'message-not-sent'
  /** Privacy mode is on but the server sent no TURN relay: we never connect directly instead. */
  | 'privacy-mode-needs-relay';

/** Everything that belongs to one peer connection, including its encrypted-signaling state. */
type PeerConnectionState = {
  peerConnection: CallPeerConnection;
  negotiation: ReturnType<typeof startPerfectNegotiation>;
  iceRestartWatch: ReturnType<typeof watchIceConnectionForRestart>;
  /** New random ID for this connection only, so recorded messages of earlier ones fail. */
  localSessionId: Uint8Array;
  /** Null until the other side's hello has arrived. */
  peerSessionId: Uint8Array | null;
  /** Our own certificate's fingerprint (normalised), and its commitment sent in our hello. */
  localFingerprint: string;
  localFingerprintCommitment: string;
  /**
   * From the other side's hello; null until it has arrived. Every offer and answer of the other
   * side must carry exactly the committed fingerprint, or the call ends.
   */
  peerFingerprintCommitment: string | null;
  /** The other side's fingerprint, once one of its descriptions has passed the commitment check. */
  committedRemoteFingerprint: string | null;
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
  /**
   * The signaling connection dropped. The peer connection is closed; a new join (new peer
   * connection, new encrypted session, new safety-code check) is tried with backoff.
   */
  onReconnecting(): void;
  /** We are back in the room. Whatever connects next is a NEW connection and is not verified. */
  onReconnected(): void;
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
   * is no connection or negotiation has not set both. If they do not show exactly the committed
   * fingerprints, the call ends and null is returned. Never log or send the returned values.
   */
  readSessionDescriptionSdps(): { localSdp: string; remoteSdp: string } | null;
  /**
   * The raw getStats() report of the current connection, or null if there is none. It contains
   * IP addresses: only feed it to the quality calculation, never log, store or show it.
   */
  readConnectionStats(): Promise<RTCStatsReport | null>;
};

/**
 * Counts peer connections across ALL sessions in this page, never resetting, so a number is never
 * reused when a new session starts and a "verified" decision cannot carry over to it.
 */
let lastPeerConnectionNumber = 0;

/**
 * Signals that may wait while the certificate for a new connection is being made. Only the other
 * side's hello can legitimately arrive then: it sends nothing else until our hello reaches it, and
 * ours is sent only once the connection exists.
 */
const MAX_SIGNALS_WHILE_OPENING = 1;

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
  /**
   * Asked at every join (first and repeated): is privacy mode on right now? A change therefore
   * takes effect on the next call or reconnect, never in the middle of a connection.
   */
  readIsPrivacyModeOn?: () => boolean;
  /**
   * Receives the ICE servers (with TURN credentials, if any): never log or store them. The
   * certificate is new for this connection and must be the only one it uses.
   */
  createPeerConnection?: (
    iceServers: RTCIceServer[],
    iceTransportPolicy: RTCIceTransportPolicy,
    certificate: RTCCertificate,
  ) => CallPeerConnection;
  /** Makes the fresh certificate (and its commitment) for each new peer connection. */
  prepareLocalCertificate?: () => Promise<LocalCertificate>;
  connectToSignaling?: typeof connectToSignalingServer;
}): CallSession {
  const { roomId, signalKey, signalingUrl, localMediaStream, events } = sessionOptions;
  const createPeerConnection =
    sessionOptions.createPeerConnection ??
    ((
      iceServers: RTCIceServer[],
      iceTransportPolicy: RTCIceTransportPolicy,
      certificate: RTCCertificate,
    ) => new RTCPeerConnection({ iceServers, iceTransportPolicy, certificates: [certificate] }));
  const prepareCertificate =
    sessionOptions.prepareLocalCertificate ?? (() => prepareLocalCertificate());
  const readIsPrivacyModeOn = sessionOptions.readIsPrivacyModeOn ?? (() => false);
  const connectToSignaling = sessionOptions.connectToSignaling ?? connectToSignalingServer;
  let signalingClient: SignalingClient | null = null;
  /** Events of an earlier signaling client (a dropped or discarded one) must be ignored. */
  let signalingGeneration = 0;
  let hasJoinedBefore = false;
  let hasEnded = false;
  let current: PeerConnectionState | null = null;
  /**
   * While the certificate for the next connection is being made: the signals that arrived
   * meanwhile (at most MAX_SIGNALS_WHILE_OPENING). Null when no connection is being opened;
   * closing or replacing the connection cancels the opening.
   */
  let pendingOpening: { queuedSignals: { payload: string; iv: string | null }[] } | null = null;
  /**
   * From our own `joined` and the privacy mode choice at that moment; kept in memory only. Every
   * peer connection of this join uses it, and a reconnect decides again. Null: do not connect.
   */
  let peerConnectionSettings: PeerConnectionSettings | null = null;
  let isPrivacyModeOnForThisJoin = false;
  /** From the latest `joined`; a peer who rejoins gets a new connection without a new `joined`. */
  let latestTurnCredentials: TurnCredentials | undefined;

  /**
   * Reads the privacy mode switch and builds the settings for the NEXT peer connection. Called
   * before every new peer connection, so none can be created in direct mode while privacy mode is
   * on. Privacy mode without a relay ends the session (no peer connection, no silent retry, no
   * direct fallback): the person can turn it off and join again. Returns false then.
   */
  function refreshPeerConnectionSettings(): boolean {
    isPrivacyModeOnForThisJoin = readIsPrivacyModeOn();
    peerConnectionSettings = buildPeerConnectionSettings(
      latestTurnCredentials,
      isPrivacyModeOnForThisJoin,
    );
    if (peerConnectionSettings !== null) return true;
    // End first, then close the socket.
    endSession('privacy-mode-needs-relay');
    signalingClient?.leaveAndClose();
    return false;
  }

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
    const peerFingerprintCommitment = signalPayload.data.fingerprintCommitment;
    if (
      peerSessionId === null ||
      peerSessionId.length !== SESSION_ID_BYTES ||
      toBase64Url(peerSessionId) !== signalPayload.data.sessionId ||
      decideSenderRoles(connection.localSessionId, peerSessionId) === null ||
      !isWellFormedFingerprintCommitment(peerFingerprintCommitment) ||
      peerFingerprintCommitment === connection.localFingerprintCommitment
    ) {
      return false; // malformed, or equal to ours (our own hello reflected back)
    }
    connection.peerSessionId = peerSessionId;
    connection.peerFingerprintCommitment = peerFingerprintCommitment;
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
        // An offer or answer must carry exactly the fingerprint the other side committed to in its
        // hello, before it is applied: else someone in the middle could pick his certificate after
        // seeing both real ones and make the safety codes match (issue #94).
        if (signalPayload.kind === 'offer' || signalPayload.kind === 'answer') {
          const peerFingerprintCommitment = connection.peerFingerprintCommitment;
          const committedRemoteFingerprint =
            peerFingerprintCommitment === null
              ? null
              : await readCommittedFingerprint(signalPayload.data.sdp, peerFingerprintCommitment);
          if (committedRemoteFingerprint === null) return failVerification();
          if (current !== connection || hasEnded) return;
          connection.committedRemoteFingerprint = committedRemoteFingerprint;
        }
        void connection.negotiation.handleRemotePayload(signalPayload);
      }
      connection.nextIncomingSequenceNumber = expectedSequenceNumber + 1;
    });
    // If handling a message throws, the queue must not stall silently: end the call.
    connection.incomingWork = connection.incomingWork.catch(() => failVerification());
  }

  function closePeerConnection(): void {
    pendingOpening = null; // a connection still being opened is cancelled too
    if (current === null) return;
    const { peerConnection, negotiation, iceRestartWatch } = current;
    current = null;
    negotiation.stop();
    iceRestartWatch.stop();
    peerConnection.ontrack = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.onsignalingstatechange = null;
    peerConnection.close();
    events.onRemoteMediaStream(null);
  }

  /**
   * Closes any connection, then makes a fresh certificate and opens the new connection with it.
   * The signals that arrive meanwhile wait (see MAX_SIGNALS_WHILE_OPENING) and are handled once
   * the connection exists. A close, a newer opening or the end of the session cancels it.
   */
  function openPeerConnection(isPolite: boolean): void {
    closePeerConnection();
    // Decided again for every peer connection, also when the other person rejoins.
    if (!refreshPeerConnectionSettings() || peerConnectionSettings === null) return;
    const settings = peerConnectionSettings;
    const sendOnlyRelayCandidates = isPrivacyModeOnForThisJoin;
    const opening: NonNullable<typeof pendingOpening> = { queuedSignals: [] };
    pendingOpening = opening;
    prepareCertificate().then(
      (localCertificate) => {
        if (pendingOpening !== opening || hasEnded) return;
        pendingOpening = null;
        let connection: PeerConnectionState;
        try {
          connection = createConnection(
            isPolite,
            settings,
            sendOnlyRelayCandidates,
            localCertificate,
          );
        } catch (creationError) {
          // For example a certificate or ICE server the browser refuses: no hello, so end now.
          events.onSessionProblem(creationError);
          endSession('message-not-sent');
          signalingClient?.leaveAndClose();
          return;
        }
        for (const queuedSignal of opening.queuedSignals) {
          receiveSignal(connection, queuedSignal.payload, queuedSignal.iv);
        }
      },
      (certificateError: unknown) => {
        if (pendingOpening !== opening || hasEnded) return;
        pendingOpening = null;
        events.onSessionProblem(certificateError);
        // Without a certificate there can be no hello: say so, don't hang.
        endSession('message-not-sent');
        signalingClient?.leaveAndClose();
      },
    );
  }

  function createConnection(
    isPolite: boolean,
    settings: PeerConnectionSettings,
    sendOnlyRelayCandidates: boolean,
    localCertificate: LocalCertificate,
  ): PeerConnectionState {
    const peerConnection = createPeerConnection(
      settings.iceServers,
      settings.iceTransportPolicy,
      localCertificate.certificate,
    );
    const negotiation = startPerfectNegotiation({
      peerConnection,
      isPolite,
      sendPayload: (payloadWithoutSequenceNumber) =>
        sendPayload(connection, payloadWithoutSequenceNumber),
      onNegotiationError: events.onSessionProblem,
      sendOnlyRelayCandidates,
    });
    const connection: PeerConnectionState = {
      peerConnection,
      negotiation,
      iceRestartWatch: watchIceConnectionForRestart({ peerConnection }),
      localSessionId: createSessionId(),
      peerSessionId: null,
      localFingerprint: localCertificate.fingerprint,
      localFingerprintCommitment: localCertificate.fingerprintCommitment,
      peerFingerprintCommitment: null,
      committedRemoteFingerprint: null,
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
    // added (`acceptHello`), which triggers `negotiationneeded` and sends the first offer. So our
    // fingerprint is committed before either side has seen the other's.
    sendPayload(connection, {
      kind: 'hello',
      data: {
        sessionId: toBase64Url(connection.localSessionId),
        fingerprintCommitment: connection.localFingerprintCommitment,
      },
    });
    return connection;
  }

  function endSession(endedReason: CallSessionEndedReason): void {
    if (hasEnded) return;
    hasEnded = true;
    reconnectScheduler.stop();
    closePeerConnection();
    events.onSessionEnded(endedReason);
  }

  /** Every join, first or repeated, gets its own client; nothing is carried over from the last. */
  function connectAndJoin(): void {
    signalingGeneration += 1;
    const generation = signalingGeneration;
    const isCurrentClient = () => generation === signalingGeneration && !hasEnded;
    signalingClient = connectToSignaling({
      signalingUrl,
      roomId,
      events: {
        onJoined(role, turnCredentials) {
          if (!isCurrentClient()) return;
          // Every join brings its own TURN credentials (or none), so a reconnect uses fresh ones.
          latestTurnCredentials = turnCredentials;
          if (!refreshPeerConnectionSettings()) return;
          hasJoinedBefore = true;
          if (reconnectScheduler.isActive) {
            reconnectScheduler.stop();
            events.onReconnected();
          }
          // `second` arrived after the other person, who is waiting for us: be polite.
          if (role === 'second') openPeerConnection(true);
        },
        onPeerJoined() {
          if (isCurrentClient()) openPeerConnection(false);
        },
        onPeerLeft() {
          if (isCurrentClient()) closePeerConnection();
        },
        onSignal(payload, initializationVector) {
          if (!isCurrentClient()) return;
          // A signal while nobody is connected is never legitimate (the server relays in order,
          // and `peer-left` comes after the peer's last signal): treat it like any bad message.
          // While a connection is being opened, the peer's hello waits for it.
          if (current !== null) receiveSignal(current, payload, initializationVector);
          else if (
            pendingOpening !== null &&
            pendingOpening.queuedSignals.length < MAX_SIGNALS_WHILE_OPENING
          ) {
            pendingOpening.queuedSignals.push({ payload, iv: initializationVector });
          } else failVerification();
        },
        onServerError(errorCode) {
          if (!isCurrentClient()) return;
          if (errorCode === 'room-full' && reconnectScheduler.isActive) {
            // The server probably still holds our old connection: drop this attempt and retry
            // until the reconnect window ends.
            const discardedClient = signalingClient;
            signalingGeneration += 1;
            discardedClient?.leaveAndClose();
            reconnectScheduler.scheduleNextAttempt();
          } else if (errorCode === 'room-full') endSession('room-full');
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
          if (!isCurrentClient()) return;
          if (closedReason === 'invalid-server-message') endSession('invalid-signaling-message');
          else if (closedReason === 'connection-lost') {
            if (reconnectScheduler.isActive) reconnectScheduler.scheduleNextAttempt();
            else if (hasJoinedBefore) startReconnecting();
            else endSession('signaling-connection-lost');
          } else endSession('hung-up');
        },
      },
    });
  }

  /** Only a dropped connection leads here; hang-up, "No", errors and failed checks never do. */
  function startReconnecting(): void {
    // The old peer connection and its encrypted session are finished: a new join starts fresh.
    closePeerConnection();
    events.onReconnecting();
    reconnectScheduler.start();
  }

  const reconnectScheduler = createReconnectScheduler({
    attemptReconnect: connectAndJoin,
    giveUp: () => {
      // End first, then close any attempt that is still connecting or already joined.
      endSession('reconnect-failed');
      signalingClient?.leaveAndClose();
    },
  });

  connectAndJoin();

  /**
   * Whether the descriptions the connection uses (which the browser rebuilds from what was applied)
   * still show exactly the committed fingerprints: ours, and the other side's that passed the
   * check. So the safety code is made from the committed pair, even if the browser's SDP parser
   * reads a fingerprint differently from ours.
   */
  function showsCommittedFingerprints(
    connection: PeerConnectionState,
    localSdp: string,
    remoteSdp: string,
  ): boolean {
    try {
      return (
        readFingerprintFromSdp(localSdp) === connection.localFingerprint &&
        readFingerprintFromSdp(remoteSdp) === connection.committedRemoteFingerprint
      );
    } catch (readError) {
      if (readError instanceof SafetyCodeError) return false;
      throw readError;
    }
  }

  return {
    readSessionDescriptionSdps() {
      // The "current" descriptions are the ones the connection is really using; a pending offer
      // that is not agreed yet must not feed the safety code.
      const connection = current;
      const localDescription = connection?.peerConnection.currentLocalDescription;
      const remoteDescription = connection?.peerConnection.currentRemoteDescription;
      if (!connection || !localDescription || !remoteDescription) return null;
      if (!showsCommittedFingerprints(connection, localDescription.sdp, remoteDescription.sdp)) {
        failVerification(); // any other fingerprint ends the call: no code is shown for it
        return null;
      }
      return { localSdp: localDescription.sdp, remoteSdp: remoteDescription.sdp };
    },
    async readConnectionStats() {
      if (hasEnded || !current) return null;
      try {
        return await current.peerConnection.getStats();
      } catch {
        return null;
      }
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
