import { describe, expect, it, vi } from 'vitest';
import { fromBase64, toBase64 } from '@/crypto/base64';
import { fromBase64Url, toBase64Url } from '@/crypto/base64url';
import { createSessionId, decideSenderRoles } from '@/crypto/signalEncryption';
import { deriveSignalKey } from '@/crypto/signalKey';
import { startCallSession, type CallPeerConnection } from '@/rtc/callSession';
import { buildIceServers, PUBLIC_STUN_ICE_SERVERS } from '@/rtc/iceServers';
import { decryptSignalPayload, encryptSignalPayload } from '@/rtc/signalPayloadCodec';
import type { SignalingClientEvents } from '@/signaling/signalingClient';
import type { SignalPayload, SignalPayloadWithoutSequenceNumber } from '@protocol/index';

function createMockPeerConnection() {
  return {
    signalingState: 'stable',
    localDescription: null,
    remoteDescription: null,
    currentLocalDescription: null,
    currentRemoteDescription: null,
    connectionState: 'new',
    getStats: vi.fn(async () => new Map() as unknown as RTCStatsReport),
    onnegotiationneeded: null as ((negotiationNeededEvent: Event) => void) | null,
    onicecandidate: null,
    ontrack: null as ((trackEvent: RTCTrackEvent) => void) | null,
    onconnectionstatechange: null,
    onsignalingstatechange: null as (() => void) | null,
    setLocalDescription: vi.fn(async () => {}),
    setRemoteDescription: vi.fn(async () => {}),
    addIceCandidate: vi.fn(async () => {}),
    addTrack: vi.fn(),
    close: vi.fn(),
  };
}

const roomSecretBytes = new Uint8Array(32).fill(7);

async function startSession(signalKey?: CryptoKey) {
  const roomSignalKey = await deriveSignalKey(roomSecretBytes);
  const peerConnections: ReturnType<typeof createMockPeerConnection>[] = [];
  const iceServersUsed: RTCIceServer[][] = [];
  const signalingClient = {
    sendSignal: vi.fn<(payload: string, iv: string) => void>(),
    leaveAndClose: vi.fn(),
  };
  let signalingEvents: SignalingClientEvents | null = null;
  const connectToSignaling = vi.fn((connectionOptions: { events: SignalingClientEvents }) => {
    signalingEvents = connectionOptions.events;
    return signalingClient;
  });
  const sessionEvents = {
    onPeerConnectionOpened: vi.fn(),
    onRemoteMediaStream: vi.fn(),
    onPeerConnectionStateChange: vi.fn(),
    onSessionDescriptionsMayHaveChanged: vi.fn(),
    onSessionProblem: vi.fn(),
    onSessionEnded: vi.fn(),
  };
  const localTrack = { kind: 'video' } as MediaStreamTrack;
  const localMediaStream = { getTracks: () => [localTrack] } as unknown as MediaStream;
  const callSession = startCallSession({
    roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
    signalKey: signalKey ?? roomSignalKey,
    signalingUrl: 'ws://localhost:8000/ws/signal/',
    localMediaStream,
    events: sessionEvents,
    createPeerConnection: (iceServers) => {
      iceServersUsed.push(iceServers);
      const mockPeerConnection = createMockPeerConnection();
      peerConnections.push(mockPeerConnection);
      return mockPeerConnection as unknown as CallPeerConnection;
    },
    connectToSignaling: connectToSignaling as never,
  });
  function server(): SignalingClientEvents {
    if (signalingEvents === null) throw new Error('not connected');
    return signalingEvents;
  }
  return {
    callSession,
    peerConnections,
    iceServersUsed,
    signalingClient,
    sessionEvents,
    server,
    localTrack,
    roomSignalKey,
  };
}

type StartedSession = Awaited<ReturnType<typeof startSession>>;

/**
 * Plays the other browser. It reads our hello to learn our session ID, then sends its own hello
 * and later messages exactly like the real peer would (encrypted, with the next seq).
 */
function createFakePeer(startedSession: StartedSession, signalKey = startedSession.roomSignalKey) {
  const { signalingClient, server } = startedSession;
  const peerSessionId = createSessionId();
  let nextPeerSequenceNumber = 0;
  let readSentCount = 0;
  let ourSessionId: Uint8Array | null = null;
  let nextOurSequenceNumber = 0;

  async function readOurHello(): Promise<Uint8Array> {
    await vi.waitFor(() => expect(signalingClient.sendSignal).toHaveBeenCalled());
    const [payload, initializationVector] = signalingClient.sendSignal.mock.calls[0]!;
    const hello = await decryptSignalPayload({
      signalKey,
      payload,
      iv: initializationVector,
      expectedSequenceNumber: 0,
      aadContext: null,
    });
    if (hello === null || hello.kind !== 'hello') throw new Error('our first message is no hello');
    readSentCount = 1;
    nextOurSequenceNumber = 1;
    ourSessionId = fromBase64Url(hello.data.sessionId)!;
    return ourSessionId;
  }

  function aadContextForPeerToUs() {
    const senderRoles = decideSenderRoles(peerSessionId, ourSessionId!)!;
    return {
      senderRole: senderRoles.ownRole,
      senderSessionId: peerSessionId,
      receiverSessionId: ourSessionId!,
    };
  }

  return {
    peerSessionId,
    readOurHello,
    async sendHello() {
      const encrypted = await encryptSignalPayload({
        signalKey,
        signalPayload: {
          kind: 'hello',
          data: { sessionId: toBase64Url(peerSessionId) },
          seq: nextPeerSequenceNumber,
        },
        aadContext: null,
      });
      nextPeerSequenceNumber += 1;
      server().onSignal(encrypted.payload, encrypted.iv);
    },
    /** Encrypts like the real peer and returns the message without delivering it. */
    async encrypt(
      payloadWithoutSequenceNumber: SignalPayloadWithoutSequenceNumber,
      sequenceNumber = nextPeerSequenceNumber,
    ) {
      nextPeerSequenceNumber = sequenceNumber + 1;
      return encryptSignalPayload({
        signalKey,
        signalPayload: { ...payloadWithoutSequenceNumber, seq: sequenceNumber } as SignalPayload,
        aadContext: aadContextForPeerToUs(),
      });
    },
    async send(payloadWithoutSequenceNumber: SignalPayloadWithoutSequenceNumber) {
      const encrypted = await this.encrypt(payloadWithoutSequenceNumber);
      server().onSignal(encrypted.payload, encrypted.iv);
      return encrypted;
    },
    /** The next payload our session sent, decrypted like the real peer would. */
    async readNextSentPayload(): Promise<SignalPayload> {
      await vi.waitFor(() =>
        expect(signalingClient.sendSignal.mock.calls.length).toBeGreaterThan(readSentCount),
      );
      const [payload, initializationVector] = signalingClient.sendSignal.mock.calls[readSentCount]!;
      readSentCount += 1;
      const ourRoles = decideSenderRoles(ourSessionId!, peerSessionId)!;
      const signalPayload = await decryptSignalPayload({
        signalKey,
        payload,
        iv: initializationVector,
        expectedSequenceNumber: nextOurSequenceNumber,
        aadContext: {
          senderRole: ourRoles.ownRole,
          senderSessionId: ourSessionId!,
          receiverSessionId: peerSessionId,
        },
      });
      nextOurSequenceNumber += 1;
      if (signalPayload === null) throw new Error('our message did not decrypt');
      return signalPayload;
    },
  };
}

/** Joins as the second peer and completes the hello exchange. */
async function startConnectedSession() {
  const startedSession = await startSession();
  startedSession.server().onJoined('second');
  const fakePeer = createFakePeer(startedSession);
  await fakePeer.readOurHello();
  await fakePeer.sendHello();
  await vi.waitFor(() => expect(startedSession.peerConnections[0]!.addTrack).toHaveBeenCalled());
  return { ...startedSession, fakePeer };
}

async function expectVerificationFailure(startedSession: StartedSession) {
  await vi.waitFor(() =>
    expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalledWith(
      'message-verification-failed',
    ),
  );
  expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalledTimes(1);
  for (const peerConnection of startedSession.peerConnections) {
    expect(peerConnection.close).toHaveBeenCalled();
  }
  expect(startedSession.signalingClient.leaveAndClose).toHaveBeenCalled();
}

const OFFER_DATA = { type: 'offer', sdp: 'remote-offer-sdp' } as const;

describe('call session', () => {
  it('the first peer waits for the other person before creating a connection', async () => {
    const { server, peerConnections } = await startSession();
    server().onJoined('first');
    expect(peerConnections).toHaveLength(0);
    server().onPeerJoined();
    expect(peerConnections).toHaveLength(1);
  });

  it('sends only an encrypted hello at first and adds the local tracks after the peer hello', async () => {
    const startedSession = await startSession();
    const { server, peerConnections, localTrack, signalingClient } = startedSession;
    server().onJoined('second');
    expect(peerConnections).toHaveLength(1);
    const fakePeer = createFakePeer(startedSession);
    await fakePeer.readOurHello();
    expect(signalingClient.sendSignal).toHaveBeenCalledTimes(1);
    expect(signalingClient.sendSignal.mock.calls[0]![1]).toMatch(/^[A-Za-z0-9+/]{16}$/);
    expect(peerConnections[0]!.addTrack).not.toHaveBeenCalled();
    await fakePeer.sendHello();
    await vi.waitFor(() =>
      expect(peerConnections[0]!.addTrack).toHaveBeenCalledWith(localTrack, expect.anything()),
    );
  });

  it('feeds a valid remote offer to the connection and sends the answer back encrypted', async () => {
    const { server, peerConnections, fakePeer } = await startConnectedSession();
    const peerConnection = peerConnections[0]!;
    peerConnection.setRemoteDescription.mockImplementation(async () => {
      peerConnection.signalingState = 'have-remote-offer';
    });
    peerConnection.setLocalDescription.mockImplementation(async () => {
      peerConnection.localDescription = { type: 'answer', sdp: 'my-answer' } as never;
    });
    await fakePeer.send({ kind: 'offer', data: OFFER_DATA });
    expect(await fakePeer.readNextSentPayload()).toEqual({
      kind: 'answer',
      data: { type: 'answer', sdp: 'my-answer' },
      seq: 1,
    });
    expect(peerConnection.setRemoteDescription).toHaveBeenCalledWith(OFFER_DATA);
    expect(server).toBeDefined();
  });

  it('sends every message with an iv and never the plaintext SDP', async () => {
    const { peerConnections, signalingClient, fakePeer } = await startConnectedSession();
    const peerConnection = peerConnections[0]!;
    peerConnection.localDescription = { type: 'offer', sdp: 'my-secret-sdp' } as never;
    peerConnection.onnegotiationneeded?.(new Event('negotiationneeded'));
    await fakePeer.readNextSentPayload();
    for (const [payload, initializationVector] of signalingClient.sendSignal.mock.calls) {
      expect(initializationVector).toMatch(/^[A-Za-z0-9+/]{16}$/);
      expect(new TextDecoder('latin1').decode(fromBase64(payload)!)).not.toContain('secret');
    }
  });

  it('reads both descriptions only when both are set', async () => {
    const startedSession = await startSession();
    const { callSession, server, peerConnections } = startedSession;
    expect(callSession.readSessionDescriptionSdps()).toBeNull();
    server().onJoined('second');
    const peerConnection = peerConnections[0]!;
    expect(callSession.readSessionDescriptionSdps()).toBeNull();
    peerConnection.currentLocalDescription = { type: 'answer', sdp: 'local-sdp' } as never;
    expect(callSession.readSessionDescriptionSdps()).toBeNull();
    peerConnection.currentRemoteDescription = { type: 'offer', sdp: 'remote-sdp' } as never;
    expect(callSession.readSessionDescriptionSdps()).toEqual({
      localSdp: 'local-sdp',
      remoteSdp: 'remote-sdp',
    });
  });

  it('ignores pending descriptions that are not the ones in use yet', async () => {
    const { callSession, server, peerConnections } = await startSession();
    server().onJoined('second');
    const peerConnection = peerConnections[0]!;
    peerConnection.localDescription = { type: 'offer', sdp: 'pending-local' } as never;
    peerConnection.remoteDescription = { type: 'answer', sdp: 'pending-remote' } as never;
    expect(callSession.readSessionDescriptionSdps()).toBeNull();
  });

  it('announces every new peer connection with a new number, so "verified" cannot carry over', async () => {
    const { server, sessionEvents } = await startSession();
    server().onJoined('first');
    server().onPeerJoined();
    server().onPeerLeft();
    server().onPeerJoined(); // someone else arrives with the same link
    const [firstNumber, secondNumber] = sessionEvents.onPeerConnectionOpened.mock.calls.map(
      (call) => call[0] as number,
    );
    expect(secondNumber).toBe(firstNumber! + 1);

    // A brand-new session must not start counting from the beginning again.
    const nextSession = await startSession();
    nextSession.server().onJoined('second');
    expect(nextSession.sessionEvents.onPeerConnectionOpened).toHaveBeenCalledWith(
      secondNumber! + 1,
    );
  });

  it('tells the page to read the descriptions again whenever the connection is stable again', async () => {
    const { server, peerConnections, sessionEvents } = await startSession();
    server().onJoined('second');
    const peerConnection = peerConnections[0]!;
    peerConnection.signalingState = 'have-remote-offer';
    peerConnection.onsignalingstatechange?.();
    expect(sessionEvents.onSessionDescriptionsMayHaveChanged).not.toHaveBeenCalled();
    peerConnection.signalingState = 'stable';
    peerConnection.onsignalingstatechange?.();
    expect(sessionEvents.onSessionDescriptionsMayHaveChanged).toHaveBeenCalledTimes(1);
  });

  it('hanging up (what "No, the codes differ" does) closes the connection and the socket', async () => {
    const { callSession, server, peerConnections, signalingClient, sessionEvents } =
      await startSession();
    server().onJoined('second');
    callSession.hangUp();
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(signalingClient.leaveAndClose).toHaveBeenCalled();
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('hung-up');
    expect(callSession.readSessionDescriptionSdps()).toBeNull();
  });

  it('replaces only the video sender track, without renegotiating (camera switch)', async () => {
    const { callSession, server, peerConnections } = await startSession();
    server().onJoined('second');
    const videoSender = { track: { kind: 'video' }, replaceTrack: vi.fn(async () => {}) };
    const audioSender = { track: { kind: 'audio' }, replaceTrack: vi.fn(async () => {}) };
    Object.assign(peerConnections[0]!, { getSenders: () => [audioSender, videoSender] });
    const newVideoTrack = { kind: 'video' } as MediaStreamTrack;
    await callSession.replaceLocalVideoTrack(newVideoTrack);
    expect(videoSender.replaceTrack).toHaveBeenCalledWith(newVideoTrack);
    expect(audioSender.replaceTrack).not.toHaveBeenCalled();
    expect(peerConnections[0]!.setLocalDescription).not.toHaveBeenCalled();
  });

  it('replacing the video track with nobody connected does nothing', async () => {
    const { callSession } = await startSession();
    await expect(
      callSession.replaceLocalVideoTrack({ kind: 'video' } as MediaStreamTrack),
    ).resolves.toBeUndefined();
  });

  it('closes the connection and clears the remote stream when the peer leaves', async () => {
    const { server, peerConnections, sessionEvents } = await startSession();
    server().onJoined('first');
    server().onPeerJoined();
    server().onPeerLeft();
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(sessionEvents.onRemoteMediaStream).toHaveBeenLastCalledWith(null);
  });

  it('a replacement peer joining closes the previous connection', async () => {
    const { server, peerConnections } = await startSession();
    server().onJoined('first');
    server().onPeerJoined();
    server().onPeerJoined();
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(peerConnections).toHaveLength(2);
  });

  it('closes the connection when the peer says bye', async () => {
    const { peerConnections, fakePeer, sessionEvents } = await startConnectedSession();
    await fakePeer.send({ kind: 'bye', data: null });
    await vi.waitFor(() => expect(peerConnections[0]!.close).toHaveBeenCalled());
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
  });

  it('forwards the remote stream from ontrack', async () => {
    const { server, peerConnections, sessionEvents } = await startSession();
    server().onJoined('second');
    const remoteMediaStream = {} as MediaStream;
    peerConnections[0]!.ontrack?.({ streams: [remoteMediaStream] } as never);
    expect(sessionEvents.onRemoteMediaStream).toHaveBeenCalledWith(remoteMediaStream);
  });

  it('ends the session when the room is full', async () => {
    const { server, sessionEvents } = await startSession();
    server().onServerError('room-full');
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('room-full');
  });

  it('ends the call when the room has expired, closing the connection and the socket', async () => {
    const { server, peerConnections, signalingClient, sessionEvents } =
      await startConnectedSession();
    server().onServerError('room-expired');
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('room-expired');
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(signalingClient.leaveAndClose).toHaveBeenCalledTimes(1);
  });

  it('ends the session on rate-limited and bad-message errors', async () => {
    for (const errorCode of ['rate-limited', 'bad-message'] as const) {
      const { server, sessionEvents } = await startSession();
      server().onServerError(errorCode);
      expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('signaling-connection-lost');
    }
  });

  it('ends the session when the signaling server sends an invalid message', async () => {
    const { server, sessionEvents } = await startSession();
    server().onClosed('invalid-server-message');
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('invalid-signaling-message');
  });

  it('hang up leaves the room and ends once', async () => {
    const { callSession, peerConnections, signalingClient, sessionEvents } =
      await startConnectedSession();
    callSession.hangUp();
    callSession.hangUp();
    expect(signalingClient.leaveAndClose).toHaveBeenCalledTimes(1);
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('hung-up');
  });
});

describe('call session: encrypted signaling fails closed', () => {
  it('a tampered payload ends the call and closes the connection and the socket', async () => {
    const startedSession = await startConnectedSession();
    const { fakePeer, server } = startedSession;
    const encrypted = await fakePeer.encrypt({ kind: 'offer', data: OFFER_DATA });
    const tamperedBytes = fromBase64(encrypted.payload)!;
    tamperedBytes[0] = tamperedBytes[0]! ^ 1;
    server().onSignal(toBase64(tamperedBytes), encrypted.iv);
    await expectVerificationFailure(startedSession);
    expect(startedSession.peerConnections[0]!.setRemoteDescription).not.toHaveBeenCalled();
  });

  it('a changed iv ends the call', async () => {
    const startedSession = await startConnectedSession();
    const encrypted = await startedSession.fakePeer.encrypt({ kind: 'offer', data: OFFER_DATA });
    const changedIvBytes = fromBase64(encrypted.iv)!;
    changedIvBytes[3] = changedIvBytes[3]! ^ 1;
    startedSession.server().onSignal(encrypted.payload, toBase64(changedIvBytes));
    await expectVerificationFailure(startedSession);
  });

  it('a missing or malformed iv ends the call', async () => {
    for (const badIv of [null, 'short', 'AAAAAAAAAAAAAAA=', '!!!!!!!!!!!!!!!!']) {
      const startedSession = await startConnectedSession();
      const encrypted = await startedSession.fakePeer.encrypt({ kind: 'offer', data: OFFER_DATA });
      startedSession.server().onSignal(encrypted.payload, badIv);
      await expectVerificationFailure(startedSession);
    }
  });

  it('the same message delivered twice ends the call', async () => {
    const startedSession = await startConnectedSession();
    const encrypted = await startedSession.fakePeer.send({ kind: 'offer', data: OFFER_DATA });
    await vi.waitFor(() =>
      expect(startedSession.peerConnections[0]!.setRemoteDescription).toHaveBeenCalledTimes(1),
    );
    startedSession.server().onSignal(encrypted.payload, encrypted.iv);
    await expectVerificationFailure(startedSession);
    expect(startedSession.peerConnections[0]!.setRemoteDescription).toHaveBeenCalledTimes(1);
  });

  it('a skipped or repeated sequence number ends the call', async () => {
    const skipped = await startConnectedSession();
    const skippedMessage = await skipped.fakePeer.encrypt({ kind: 'offer', data: OFFER_DATA }, 2);
    skipped.server().onSignal(skippedMessage.payload, skippedMessage.iv);
    await expectVerificationFailure(skipped);

    const repeated = await startConnectedSession();
    const repeatedMessage = await repeated.fakePeer.encrypt({ kind: 'bye', data: null }, 0);
    repeated.server().onSignal(repeatedMessage.payload, repeatedMessage.iv);
    await expectVerificationFailure(repeated);
  });

  it('a message from an earlier session ends the call', async () => {
    // Session 1: the peer sends an offer that a server recorded.
    const earlier = await startConnectedSession();
    const recorded = await earlier.fakePeer.encrypt({ kind: 'offer', data: OFFER_DATA });

    // Session 2 (same link, same key): our side has a new session ID, so the recording is useless.
    const later = await startConnectedSession();
    later.server().onSignal(recorded.payload, recorded.iv);
    await expectVerificationFailure(later);
    expect(later.peerConnections[0]!.setRemoteDescription).not.toHaveBeenCalled();
  });

  it('a peer who rejoins gets a new session ID, so its old messages fail', async () => {
    const startedSession = await startConnectedSession();
    const { server, fakePeer, signalingClient } = startedSession;
    const recorded = await fakePeer.encrypt({ kind: 'offer', data: OFFER_DATA });
    server().onPeerLeft();
    server().onPeerJoined();
    // The new connection has a new hello of its own and must not accept the recording.
    await vi.waitFor(() => expect(signalingClient.sendSignal).toHaveBeenCalledTimes(2));
    server().onSignal(recorded.payload, recorded.iv);
    await expectVerificationFailure(startedSession);
  });

  it('a hello with a changed session ID, or a second hello, ends the call', async () => {
    const startedSession = await startConnectedSession();
    await startedSession.fakePeer.send({
      kind: 'hello',
      data: { sessionId: toBase64Url(createSessionId()) },
    });
    await expectVerificationFailure(startedSession);
  });

  it('anything but a hello before the hello ends the call', async () => {
    const startedSession = await startSession();
    startedSession.server().onJoined('second');
    const fakePeer = createFakePeer(startedSession);
    await fakePeer.readOurHello();
    const encrypted = await encryptSignalPayload({
      signalKey: startedSession.roomSignalKey,
      signalPayload: { kind: 'bye', data: null, seq: 0 },
      aadContext: null,
    });
    startedSession.server().onSignal(encrypted.payload, encrypted.iv);
    await expectVerificationFailure(startedSession);
  });

  it('our own hello reflected back to us ends the call', async () => {
    const startedSession = await startSession();
    startedSession.server().onJoined('second');
    await vi.waitFor(() => expect(startedSession.signalingClient.sendSignal).toHaveBeenCalled());
    const [payload, initializationVector] =
      startedSession.signalingClient.sendSignal.mock.calls[0]!;
    startedSession.server().onSignal(payload, initializationVector);
    await expectVerificationFailure(startedSession);
  });

  it('a message reflected back to us ends the call', async () => {
    const startedSession = await startConnectedSession();
    startedSession.peerConnections[0]!.localDescription = { type: 'offer', sdp: 'x' } as never;
    startedSession.peerConnections[0]!.onnegotiationneeded?.(new Event('negotiationneeded'));
    await vi.waitFor(() =>
      expect(startedSession.signalingClient.sendSignal).toHaveBeenCalledTimes(2),
    );
    const [payload, initializationVector] =
      startedSession.signalingClient.sendSignal.mock.calls[1]!;
    startedSession.server().onSignal(payload, initializationVector);
    await expectVerificationFailure(startedSession);
  });

  it('a message encrypted with another room key ends the call', async () => {
    const startedSession = await startSession();
    startedSession.server().onJoined('second');
    const otherKey = await deriveSignalKey(new Uint8Array(32).fill(9));
    const fakePeer = createFakePeer(startedSession, otherKey);
    await vi.waitFor(() => expect(startedSession.signalingClient.sendSignal).toHaveBeenCalled());
    // Learn our session ID the honest way, then answer with the wrong key.
    const [payload, initializationVector] =
      startedSession.signalingClient.sendSignal.mock.calls[0]!;
    const ourHello = await decryptSignalPayload({
      signalKey: startedSession.roomSignalKey,
      payload,
      iv: initializationVector,
      expectedSequenceNumber: 0,
      aadContext: null,
    });
    expect(ourHello?.kind).toBe('hello');
    await fakePeer.sendHello();
    await expectVerificationFailure(startedSession);
  });

  it('a signal that arrives when nobody is connected ends the call', async () => {
    const startedSession = await startSession();
    startedSession.server().onJoined('first');
    startedSession.server().onSignal('QUJD', 'AAAAAAAAAAAAAAAA');
    await vi.waitFor(() =>
      expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalledWith(
        'message-verification-failed',
      ),
    );
    expect(startedSession.signalingClient.leaveAndClose).toHaveBeenCalled();
  });

  it('an offer that is too large to send is refused and ends the call', async () => {
    const { peerConnections, sessionEvents, signalingClient } = await startConnectedSession();
    const peerConnection = peerConnections[0]!;
    peerConnection.localDescription = { type: 'offer', sdp: '€'.repeat(40000) } as never;
    peerConnection.onnegotiationneeded?.(new Event('negotiationneeded'));
    await vi.waitFor(() =>
      expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('message-not-sent'),
    );
    expect(signalingClient.sendSignal).toHaveBeenCalledTimes(1); // only the hello
    expect(signalingClient.leaveAndClose).toHaveBeenCalled();
    expect(peerConnection.close).toHaveBeenCalled();
  });

  it('an error while handling an incoming message ends the call instead of stalling', async () => {
    const startedSession = await startSession();
    startedSession.server().onJoined('second');
    startedSession.peerConnections[0]!.addTrack.mockImplementation(() => {
      throw new Error('addTrack failed');
    });
    const fakePeer = createFakePeer(startedSession);
    await fakePeer.readOurHello();
    await fakePeer.sendHello();
    await expectVerificationFailure(startedSession);
  });

  describe('TURN credentials', () => {
    const turnCredentials = {
      urls: ['turn:turn.example.com:3478?transport=udp'],
      username: '1700003600:AAECAwQFBgcICQoLDA0ODw',
      credential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    };

    it('builds the connection with the TURN server and STUN after joined with turn', async () => {
      const { server, iceServersUsed } = await startSession();
      server().onJoined('second', turnCredentials);
      expect(iceServersUsed).toEqual([buildIceServers(turnCredentials)]);
      expect(iceServersUsed[0]![0]).toMatchObject({
        username: turnCredentials.username,
        credential: turnCredentials.credential,
      });
    });

    it('uses STUN only after joined without turn', async () => {
      const { server, iceServersUsed } = await startSession();
      server().onJoined('second');
      expect(iceServersUsed).toEqual([PUBLIC_STUN_ICE_SERVERS]);
    });

    it('the person who gets peer-joined uses the credentials from their own joined', async () => {
      const { server, iceServersUsed } = await startSession();
      server().onJoined('first', turnCredentials);
      expect(iceServersUsed).toHaveLength(0);
      server().onPeerJoined();
      server().onPeerLeft();
      server().onPeerJoined();
      expect(iceServersUsed).toEqual([
        buildIceServers(turnCredentials),
        buildIceServers(turnCredentials),
      ]);
    });

    it('never puts the credential into a session problem', async () => {
      const startedSession = await startSession();
      startedSession.server().onJoined('second', turnCredentials);
      startedSession.peerConnections[0]!.addTrack.mockImplementation(() => {
        throw new Error('addTrack failed');
      });
      const fakePeer = createFakePeer(startedSession);
      await fakePeer.readOurHello();
      await fakePeer.sendHello();
      await vi.waitFor(() =>
        expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalled(),
      );
      const everythingReported = JSON.stringify([
        ...startedSession.sessionEvents.onSessionProblem.mock.calls.map(([problem]) =>
          problem instanceof Error ? problem.message : problem,
        ),
        ...startedSession.sessionEvents.onSessionEnded.mock.calls,
      ]);
      expect(everythingReported).not.toContain(turnCredentials.credential);
      expect(everythingReported).not.toContain(turnCredentials.username);
    });
  });

  it('valid messages in order are all accepted', async () => {
    const { fakePeer, peerConnections, sessionEvents } = await startConnectedSession();
    await fakePeer.send({ kind: 'offer', data: OFFER_DATA });
    await fakePeer.send({ kind: 'candidate', data: { candidate: 'candidate:1' } });
    await vi.waitFor(() => expect(peerConnections[0]!.addIceCandidate).toHaveBeenCalled());
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
  });
});
