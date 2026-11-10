import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from '@/crypto/base64url';
import { createSessionId } from '@/crypto/signalEncryption';
import { deriveSignalKey } from '@/crypto/signalKey';
import { startCallSession, type CallPeerConnection } from '@/rtc/callSession';
import { RECONNECT_WINDOW_MILLISECONDS } from '@/rtc/reconnect';
import { decryptSignalPayload, encryptSignalPayload } from '@/rtc/signalPayloadCodec';
import type { SignalingClientEvents } from '@/signaling/signalingClient';

/** Real polling (setImmediate), because fake timers must not move while crypto finishes. */
async function waitUntil(condition: () => boolean) {
  for (let i = 0; i < 2000 && !condition(); i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}

function createMockPeerConnection() {
  return {
    signalingState: 'stable',
    localDescription: null,
    remoteDescription: null,
    currentLocalDescription: null,
    currentRemoteDescription: null,
    connectionState: 'new',
    iceConnectionState: 'new',
    onnegotiationneeded: null,
    onicecandidate: null,
    ontrack: null,
    onconnectionstatechange: null,
    onsignalingstatechange: null,
    oniceconnectionstatechange: null,
    setLocalDescription: vi.fn(async () => {}),
    setRemoteDescription: vi.fn(async () => {}),
    addIceCandidate: vi.fn(async () => {}),
    addTrack: vi.fn(),
    restartIce: vi.fn(),
    close: vi.fn(),
  };
}

async function startSession() {
  const signalKey = await deriveSignalKey(new Uint8Array(32).fill(9));
  const peerConnections: ReturnType<typeof createMockPeerConnection>[] = [];
  const signalingClients: {
    events: SignalingClientEvents;
    sendSignal: ReturnType<typeof vi.fn<(payload: string, iv: string) => void>>;
    leaveAndClose: ReturnType<typeof vi.fn>;
  }[] = [];
  const connectToSignaling = vi.fn((connectionOptions: { events: SignalingClientEvents }) => {
    const signalingClient = {
      events: connectionOptions.events,
      sendSignal: vi.fn<(payload: string, iv: string) => void>(),
      leaveAndClose: vi.fn(),
    };
    signalingClients.push(signalingClient);
    return signalingClient;
  });
  const sessionEvents = {
    onPeerConnectionOpened: vi.fn(),
    onRemoteMediaStream: vi.fn(),
    onPeerConnectionStateChange: vi.fn(),
    onSessionDescriptionsMayHaveChanged: vi.fn(),
    onSessionProblem: vi.fn(),
    onReconnecting: vi.fn(),
    onReconnected: vi.fn(),
    onSessionEnded: vi.fn(),
  };
  const callSession = startCallSession({
    roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
    signalKey,
    signalingUrl: 'ws://localhost:8000/ws/signal/',
    localMediaStream: { getTracks: () => [] } as unknown as MediaStream,
    events: sessionEvents,
    createPeerConnection: () => {
      const mockPeerConnection = createMockPeerConnection();
      peerConnections.push(mockPeerConnection);
      return mockPeerConnection as unknown as CallPeerConnection;
    },
    connectToSignaling: connectToSignaling as never,
  });

  /** Reads the hello (always the first message, seq 0) our session sent on a given client. */
  async function readHelloOfClient(clientIndex: number) {
    const client = signalingClients[clientIndex]!;
    await waitUntil(() => client.sendSignal.mock.calls.length > 0);
    const [payload, initializationVector] = client.sendSignal.mock.calls[0]!;
    const hello = await decryptSignalPayload({
      signalKey,
      payload,
      iv: initializationVector,
      expectedSequenceNumber: 0,
      aadContext: null,
    });
    if (hello === null || hello.kind !== 'hello') throw new Error('first message is no hello');
    return hello;
  }
  async function deliverPeerHello(clientIndex: number) {
    const encrypted = await encryptSignalPayload({
      signalKey,
      signalPayload: {
        kind: 'hello',
        data: { sessionId: toBase64Url(createSessionId()) },
        seq: 0,
      },
      aadContext: null,
    });
    signalingClients[clientIndex]!.events.onSignal(encrypted.payload, encrypted.iv);
  }
  return {
    callSession,
    peerConnections,
    signalingClients,
    connectToSignaling,
    sessionEvents,
    readHelloOfClient,
    deliverPeerHello,
  };
}

/** A call in progress: joined as `second`, hellos exchanged on the first client. */
async function startConnectedSession() {
  const startedSession = await startSession();
  startedSession.signalingClients[0]!.events.onJoined('second');
  await startedSession.readHelloOfClient(0);
  await startedSession.deliverPeerHello(0);
  return startedSession;
}

async function dropSocketAndReconnect(startedSession: Awaited<ReturnType<typeof startSession>>) {
  startedSession.signalingClients[0]!.events.onClosed('connection-lost');
  await vi.advanceTimersByTimeAsync(1000);
}

describe('call session: signaling reconnect', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('a dropped socket closes the connection, reconnects after 1 s and rejoins the same room', async () => {
    const startedSession = await startConnectedSession();
    const { signalingClients, connectToSignaling, sessionEvents, peerConnections } = startedSession;
    signalingClients[0]!.events.onClosed('connection-lost');
    expect(sessionEvents.onReconnecting).toHaveBeenCalledTimes(1);
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
    expect(connectToSignaling).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(connectToSignaling).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connectToSignaling).toHaveBeenCalledTimes(2);
    expect(connectToSignaling.mock.calls[1]![0]).toMatchObject({
      roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
  });

  it('retries with backoff while the new connection also fails', async () => {
    const startedSession = await startConnectedSession();
    const { signalingClients, connectToSignaling } = startedSession;
    await dropSocketAndReconnect(startedSession);
    signalingClients[1]!.events.onClosed('connection-lost');
    await vi.advanceTimersByTimeAsync(1999);
    expect(connectToSignaling).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connectToSignaling).toHaveBeenCalledTimes(3);
  });

  it('starts a new session after rejoining: new session ID, new hello at seq 0, new connection number', async () => {
    const startedSession = await startConnectedSession();
    const { signalingClients, sessionEvents, peerConnections } = startedSession;
    const firstHello = await startedSession.readHelloOfClient(0);
    const peerConnectionNumbersBefore = sessionEvents.onPeerConnectionOpened.mock.calls.length;
    await dropSocketAndReconnect(startedSession);
    signalingClients[1]!.events.onJoined('second');
    expect(sessionEvents.onReconnected).toHaveBeenCalledTimes(1);
    const secondHello = await startedSession.readHelloOfClient(1);
    // readHelloOfClient decrypts with seq 0 and no session: this only works for a fresh session.
    expect(secondHello.data.sessionId).not.toBe(firstHello.data.sessionId);
    expect(peerConnections).toHaveLength(2);
    expect(sessionEvents.onPeerConnectionOpened).toHaveBeenCalledTimes(
      peerConnectionNumbersBefore + 1,
    );
    const [firstNumber] = sessionEvents.onPeerConnectionOpened.mock.calls[0]!;
    const [secondNumber] = sessionEvents.onPeerConnectionOpened.mock.calls[1]!;
    expect(secondNumber).not.toBe(firstNumber);
    // The new connection sends nothing but its hello until the peer's new hello arrives.
    expect(signalingClients[1]!.sendSignal).toHaveBeenCalledTimes(1);
    expect(peerConnections[1]!.addTrack).not.toHaveBeenCalled();
  });

  it('a message recorded from the old session is refused in the new one', async () => {
    const startedSession = await startConnectedSession();
    const { signalingClients, sessionEvents } = startedSession;
    const signalKey = await deriveSignalKey(new Uint8Array(32).fill(9));
    const recordedOldHello = await encryptSignalPayload({
      signalKey,
      signalPayload: { kind: 'hello', data: { sessionId: toBase64Url(createSessionId()) }, seq: 3 },
      aadContext: null,
    });
    await dropSocketAndReconnect(startedSession);
    signalingClients[1]!.events.onJoined('second');
    await startedSession.readHelloOfClient(1);
    signalingClients[1]!.events.onSignal(recordedOldHello.payload, recordedOldHello.iv);
    await waitUntil(() => sessionEvents.onSessionEnded.mock.calls.length > 0);
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('message-verification-failed');
  });

  it('retries room-full until the two-minute window ends, then gives up', async () => {
    const startedSession = await startConnectedSession();
    const { signalingClients, connectToSignaling, sessionEvents } = startedSession;
    await dropSocketAndReconnect(startedSession);
    let attemptCount = 2;
    // Every attempt is told the room is still full.
    for (let elapsed = 1000; elapsed < RECONNECT_WINDOW_MILLISECONDS;) {
      expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
      signalingClients[attemptCount - 1]!.events.onServerError('room-full');
      expect(signalingClients[attemptCount - 1]!.leaveAndClose).toHaveBeenCalled();
      const nextDelay = Math.min(1000 * 2 ** (attemptCount - 1), 15_000);
      if (elapsed + nextDelay >= RECONNECT_WINDOW_MILLISECONDS) break;
      await vi.advanceTimersByTimeAsync(nextDelay);
      elapsed += nextDelay;
      attemptCount += 1;
      expect(connectToSignaling).toHaveBeenCalledTimes(attemptCount);
    }
    await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MILLISECONDS);
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('reconnect-failed');
    const attemptsAtEnd = connectToSignaling.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MILLISECONDS);
    expect(connectToSignaling).toHaveBeenCalledTimes(attemptsAtEnd);
  });

  it('a successful retry after room-full rejoins', async () => {
    const startedSession = await startConnectedSession();
    const { signalingClients, sessionEvents, connectToSignaling } = startedSession;
    await dropSocketAndReconnect(startedSession);
    signalingClients[1]!.events.onServerError('room-full');
    await vi.advanceTimersByTimeAsync(2000);
    expect(connectToSignaling).toHaveBeenCalledTimes(3);
    signalingClients[2]!.events.onJoined('first');
    expect(sessionEvents.onReconnected).toHaveBeenCalledTimes(1);
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
    // A late event of the discarded attempt changes nothing.
    signalingClients[1]!.events.onClosed('closed-by-us');
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
  });

  it('room-full on the very first join still ends the call at once', async () => {
    const { signalingClients, sessionEvents } = await startSession();
    signalingClients[0]!.events.onServerError('room-full');
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('room-full');
  });

  it('a socket that fails before the first join is not retried', async () => {
    const { signalingClients, sessionEvents, connectToSignaling } = await startSession();
    signalingClients[0]!.events.onClosed('connection-lost');
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('signaling-connection-lost');
    await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MILLISECONDS);
    expect(connectToSignaling).toHaveBeenCalledTimes(1);
  });
});

describe('call session: no reconnect when the end is final', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  async function expectNoReconnect(startedSession: Awaited<ReturnType<typeof startSession>>) {
    startedSession.signalingClients[0]!.events.onClosed('connection-lost');
    await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MILLISECONDS * 2);
    expect(startedSession.connectToSignaling).toHaveBeenCalledTimes(1);
    expect(startedSession.sessionEvents.onReconnecting).not.toHaveBeenCalled();
    expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalledTimes(1);
  }

  it('hang-up (also what "No" does) never reconnects', async () => {
    const startedSession = await startConnectedSession();
    startedSession.callSession.hangUp();
    await expectNoReconnect(startedSession);
    expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalledWith('hung-up');
  });

  it('room-expired never reconnects', async () => {
    const startedSession = await startConnectedSession();
    startedSession.signalingClients[0]!.events.onServerError('room-expired');
    await expectNoReconnect(startedSession);
    expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalledWith('room-expired');
  });

  it('a verification failure never reconnects', async () => {
    const startedSession = await startConnectedSession();
    startedSession.signalingClients[0]!.events.onSignal('AAAA', 'AAAAAAAAAAAAAAAA');
    await waitUntil(() => startedSession.sessionEvents.onSessionEnded.mock.calls.length > 0);
    await expectNoReconnect(startedSession);
    expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalledWith(
      'message-verification-failed',
    );
  });

  it('hanging up while reconnecting stops all attempts', async () => {
    const startedSession = await startConnectedSession();
    startedSession.signalingClients[0]!.events.onClosed('connection-lost');
    startedSession.callSession.hangUp();
    await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MILLISECONDS * 2);
    expect(startedSession.connectToSignaling).toHaveBeenCalledTimes(1);
    expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalledWith('hung-up');
  });

  it('room-expired while reconnecting ends the call for good', async () => {
    const startedSession = await startConnectedSession();
    await dropSocketAndReconnect(startedSession);
    startedSession.signalingClients[1]!.events.onServerError('room-expired');
    await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MILLISECONDS * 2);
    expect(startedSession.connectToSignaling).toHaveBeenCalledTimes(2);
    expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalledWith('room-expired');
  });
});

describe('call session: ICE restart', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('restarts ICE on the same connection and keeps the same session (no new hello)', async () => {
    const { peerConnections, signalingClients, sessionEvents } = await startConnectedSession();
    const peerConnection = peerConnections[0]!;
    peerConnection.iceConnectionState = 'failed';
    (peerConnection.oniceconnectionstatechange as unknown as () => void)();
    expect(peerConnection.restartIce).toHaveBeenCalledTimes(1);
    expect(peerConnections).toHaveLength(1);
    expect(signalingClients).toHaveLength(1);
    expect(sessionEvents.onPeerConnectionOpened).toHaveBeenCalledTimes(1);
  });
});
