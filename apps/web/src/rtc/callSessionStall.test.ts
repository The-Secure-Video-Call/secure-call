import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromBase64Url, toBase64Url } from '@/crypto/base64url';
import { computeFingerprintCommitment } from '@/crypto/fingerprintCommitment';
import { createSessionId, decideSenderRoles } from '@/crypto/signalEncryption';
import { deriveSignalKey } from '@/crypto/signalKey';
import {
  MAX_WAITING_INCOMING_MESSAGES,
  PEER_STALL_TIMEOUT_MILLISECONDS,
  startCallSession,
  type CallPeerConnection,
} from '@/rtc/callSession';
import type { LocalCertificate } from '@/rtc/localCertificate';
import { RECONNECT_WINDOW_MILLISECONDS } from '@/rtc/reconnect';
import { decryptSignalPayload, encryptSignalPayload } from '@/rtc/signalPayloadCodec';
import type { SignalingClientEvents } from '@/signaling/signalingClient';
import type { SignalPayloadWithoutSequenceNumber } from '@protocol/index';

/** A normalised SHA-256 fingerprint with every byte set to `byteValue`. */
function fakeFingerprint(byteValue: number): string {
  const hexByte = byteValue.toString(16).padStart(2, '0').toUpperCase();
  return `sha-256 ${Array.from({ length: 32 }, () => hexByte).join(':')}`;
}

const PEER_FINGERPRINT = fakeFingerprint(0xab);
const PEER_FINGERPRINT_COMMITMENT = await computeFingerprintCommitment(PEER_FINGERPRINT);
const LOCAL_CERTIFICATES: LocalCertificate[] = await Promise.all(
  Array.from({ length: 4 }, async (_, certificateIndex) => ({
    certificate: { fakeCertificateNumber: certificateIndex } as unknown as RTCCertificate,
    fingerprint: fakeFingerprint(certificateIndex),
    fingerprintCommitment: await computeFingerprintCommitment(fakeFingerprint(certificateIndex)),
  })),
);

const WAIT_UNTIL_LIMIT_MILLISECONDS = 3_000;

/** Real polling (setImmediate): fake timers must not move while Web Crypto finishes. */
async function waitUntil(condition: () => boolean) {
  const deadline = performance.now() + WAIT_UNTIL_LIMIT_MILLISECONDS;
  while (!condition() && performance.now() < deadline) {
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
  let preparedCertificateCount = 0;
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
    prepareLocalCertificate: async () => {
      const localCertificate = LOCAL_CERTIFICATES[preparedCertificateCount];
      preparedCertificateCount += 1;
      if (localCertificate === undefined) throw new Error('out of fake certificates');
      return localCertificate;
    },
    connectToSignaling: connectToSignaling as never,
  });

  /** Plays the other browser on one signaling client. */
  function createFakePeer(clientIndex: number) {
    const client = signalingClients[clientIndex]!;
    const peerSessionId = createSessionId();
    let nextPeerSequenceNumber = 0;
    let ourSessionId: Uint8Array | null = null;
    return {
      async readOurHello() {
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
        ourSessionId = fromBase64Url(hello.data.sessionId);
      },
      async encryptHello() {
        const encrypted = await encryptSignalPayload({
          signalKey,
          signalPayload: {
            kind: 'hello',
            data: {
              sessionId: toBase64Url(peerSessionId),
              fingerprintCommitment: PEER_FINGERPRINT_COMMITMENT,
            },
            seq: nextPeerSequenceNumber,
          },
          aadContext: null,
        });
        nextPeerSequenceNumber += 1;
        return encrypted;
      },
      async sendHello() {
        const encrypted = await this.encryptHello();
        client.events.onSignal(encrypted.payload, encrypted.iv);
      },
      /** Encrypts a message like the real peer would, without delivering it. */
      async encrypt(payloadWithoutSequenceNumber: SignalPayloadWithoutSequenceNumber) {
        const senderRoles = decideSenderRoles(peerSessionId, ourSessionId!)!;
        const encrypted = await encryptSignalPayload({
          signalKey,
          signalPayload: {
            ...payloadWithoutSequenceNumber,
            seq: nextPeerSequenceNumber,
          } as never,
          aadContext: {
            senderRole: senderRoles.ownRole,
            senderSessionId: peerSessionId,
            receiverSessionId: ourSessionId!,
          },
        });
        nextPeerSequenceNumber += 1;
        return encrypted;
      },
      async send(payloadWithoutSequenceNumber: SignalPayloadWithoutSequenceNumber) {
        const encrypted = await this.encrypt(payloadWithoutSequenceNumber);
        client.events.onSignal(encrypted.payload, encrypted.iv);
      },
    };
  }
  return {
    callSession,
    peerConnections,
    signalingClients,
    connectToSignaling,
    sessionEvents,
    createFakePeer,
  };
}

/** Both hellos are exchanged on the first client; the peer then stays silent. */
async function startSessionAfterHello(role: 'first' | 'second') {
  const startedSession = await startSession();
  const { signalingClients, peerConnections } = startedSession;
  signalingClients[0]!.events.onJoined(role);
  if (role === 'first') {
    signalingClients[0]!.events.onPeerJoined();
  }
  await waitUntil(() => peerConnections.length === 1);
  const fakePeer = startedSession.createFakePeer(0);
  await fakePeer.readOurHello();
  await fakePeer.sendHello();
  // The peer's hello is accepted (and the stall timer started) once it is decrypted.
  await waitUntil(() => vi.getTimerCount() === 1);
  return { ...startedSession, fakePeer };
}

const OFFER_DATA = {
  type: 'offer',
  sdp: `v=0\r\ns=offer\r\na=fingerprint:${PEER_FINGERPRINT}\r\n`,
} as const;
const ANSWER_DATA = {
  type: 'answer',
  sdp: `v=0\r\ns=answer\r\na=fingerprint:${PEER_FINGERPRINT}\r\n`,
} as const;

describe('call session: a peer that stalls after hello (threat-model limit 7)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('a peer that says hello and then nothing ends the call after the timeout', async () => {
    const { sessionEvents, signalingClients, peerConnections } =
      await startSessionAfterHello('second');
    await vi.advanceTimersByTimeAsync(PEER_STALL_TIMEOUT_MILLISECONDS - 1);
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('message-verification-failed');
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(signalingClients[0]!.leaveAndClose).toHaveBeenCalled();
  });

  for (const role of ['first', 'second'] as const) {
    it(`${role}: an offer in time keeps the call`, async () => {
      const { sessionEvents, fakePeer } = await startSessionAfterHello(role);
      await vi.advanceTimersByTimeAsync(PEER_STALL_TIMEOUT_MILLISECONDS - 1000);
      await fakePeer.send({ kind: 'offer', data: OFFER_DATA });
      await waitUntil(() => vi.getTimerCount() === 0);
      await vi.advanceTimersByTimeAsync(PEER_STALL_TIMEOUT_MILLISECONDS * 3);
      expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
    });

    it(`${role}: only an answer in time keeps the call`, async () => {
      const { sessionEvents, fakePeer } = await startSessionAfterHello(role);
      await vi.advanceTimersByTimeAsync(PEER_STALL_TIMEOUT_MILLISECONDS - 1000);
      await fakePeer.send({ kind: 'answer', data: ANSWER_DATA });
      await waitUntil(() => vi.getTimerCount() === 0);
      await vi.advanceTimersByTimeAsync(PEER_STALL_TIMEOUT_MILLISECONDS * 3);
      expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
    });
  }

  it('an offer that arrives too late is too late: the call has already ended', async () => {
    const { sessionEvents } = await startSessionAfterHello('second');
    await vi.advanceTimersByTimeAsync(PEER_STALL_TIMEOUT_MILLISECONDS);
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('message-verification-failed');
  });

  it('a message that is not an offer or answer does not stop the timer', async () => {
    const { sessionEvents, fakePeer } = await startSessionAfterHello('second');
    await fakePeer.send({
      kind: 'candidate',
      data: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' },
    });
    await vi.advanceTimersByTimeAsync(PEER_STALL_TIMEOUT_MILLISECONDS);
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('message-verification-failed');
  });

  it('no timer runs before the peer has said hello', async () => {
    const { sessionEvents, signalingClients, peerConnections } = await startSession();
    signalingClients[0]!.events.onJoined('second');
    await waitUntil(() => peerConnections.length === 1);
    await vi.advanceTimersByTimeAsync(PEER_STALL_TIMEOUT_MILLISECONDS * 3);
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
  });

  it('hanging up clears the timer', async () => {
    const { sessionEvents, callSession } = await startSessionAfterHello('second');
    callSession.hangUp();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PEER_STALL_TIMEOUT_MILLISECONDS * 3);
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('hung-up');
  });

  it('the peer leaving (the connection closing) clears the timer', async () => {
    const { sessionEvents, signalingClients } = await startSessionAfterHello('second');
    signalingClients[0]!.events.onPeerLeft();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PEER_STALL_TIMEOUT_MILLISECONDS * 3);
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
  });

  it('a dropped socket (reconnect) clears the timer, and the old timer cannot end the new join', async () => {
    const { sessionEvents, signalingClients } = await startSessionAfterHello('second');
    signalingClients[0]!.events.onClosed('connection-lost');
    await vi.advanceTimersByTimeAsync(PEER_STALL_TIMEOUT_MILLISECONDS);
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalledWith('message-verification-failed');
    expect(RECONNECT_WINDOW_MILLISECONDS).toBeGreaterThan(PEER_STALL_TIMEOUT_MILLISECONDS);
  });

  it('a message that fails verification ends the call at once and leaves no timer behind', async () => {
    const { sessionEvents, signalingClients } = await startSessionAfterHello('second');
    signalingClients[0]!.events.onSignal('AAAA', 'AAAA');
    await waitUntil(() => sessionEvents.onSessionEnded.mock.calls.length > 0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('call session: a flood of incoming messages (threat-model limit 7)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  async function encryptCandidates(
    fakePeer: Awaited<ReturnType<typeof startSessionAfterHello>>['fakePeer'],
    count: number,
  ) {
    const encryptedCandidates: { payload: string; iv: string }[] = [];
    for (let i = 0; i < count; i += 1) {
      encryptedCandidates.push(
        await fakePeer.encrypt({
          kind: 'candidate',
          data: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' },
        }),
      );
    }
    return encryptedCandidates;
  }

  it('exactly the cap of valid messages waiting at once is accepted (a normal burst)', async () => {
    const { sessionEvents, signalingClients, peerConnections, fakePeer } =
      await startSessionAfterHello('second');
    const encryptedCandidates = await encryptCandidates(fakePeer, MAX_WAITING_INCOMING_MESSAGES);
    for (const encrypted of encryptedCandidates) {
      signalingClients[0]!.events.onSignal(encrypted.payload, encrypted.iv);
    }
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
    await waitUntil(() => peerConnections[0]!.addIceCandidate.mock.calls.length > 0);
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
  });

  it('one message above the cap fails verification at once, valid or not', async () => {
    const { sessionEvents, signalingClients, peerConnections, fakePeer } =
      await startSessionAfterHello('second');
    const encryptedCandidates = await encryptCandidates(
      fakePeer,
      MAX_WAITING_INCOMING_MESSAGES + 1,
    );
    for (const encrypted of encryptedCandidates.slice(0, MAX_WAITING_INCOMING_MESSAGES)) {
      signalingClients[0]!.events.onSignal(encrypted.payload, encrypted.iv);
    }
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
    const overflow = encryptedCandidates[MAX_WAITING_INCOMING_MESSAGES]!;
    signalingClients[0]!.events.onSignal(overflow.payload, overflow.iv);
    // Synchronously: it is the cap that ended the call, not a failed decryption later.
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('message-verification-failed');
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(signalingClients[0]!.leaveAndClose).toHaveBeenCalled();
  });

  it('messages handled one after the other never add up to the cap', async () => {
    const { sessionEvents, fakePeer, peerConnections } = await startSessionAfterHello('second');
    for (let i = 0; i < MAX_WAITING_INCOMING_MESSAGES * 2; i += 1) {
      await fakePeer.send({
        kind: 'candidate',
        data: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' },
      });
      await waitUntil(() => peerConnections[0]!.addIceCandidate.mock.calls.length >= i + 1);
    }
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalledWith('message-verification-failed');
  });
});
