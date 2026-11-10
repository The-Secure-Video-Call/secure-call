import { describe, expect, it, vi } from 'vitest';
import { fromBase64, toBase64 } from '@/crypto/base64';
import { fromBase64Url, toBase64Url } from '@/crypto/base64url';
import { computeFingerprintCommitment } from '@/crypto/fingerprintCommitment';
import {
  buildHelloAad,
  createSessionId,
  decideSenderRoles,
  encryptSignalBytes,
} from '@/crypto/signalEncryption';
import { deriveSignalKey } from '@/crypto/signalKey';
import { startCallSession, type CallPeerConnection } from '@/rtc/callSession';
import type { LocalCertificate } from '@/rtc/localCertificate';
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
    iceConnectionState: 'new',
    oniceconnectionstatechange: null,
    restartIce: vi.fn(),
    getStats: vi.fn(async () => new Map() as unknown as RTCStatsReport),
    onnegotiationneeded: null as ((negotiationNeededEvent: Event) => void) | null,
    onicecandidate: null as ((iceCandidateEvent: RTCPeerConnectionIceEvent) => void) | null,
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

/** A normalised SHA-256 fingerprint with every byte set to `byteValue`. */
function fakeFingerprint(byteValue: number): string {
  const hexByte = byteValue.toString(16).padStart(2, '0').toUpperCase();
  return `sha-256 ${Array.from({ length: 32 }, () => hexByte).join(':')}`;
}

/** An SDP with one DTLS fingerprint line (all the commitment check reads). */
function sdpWithFingerprint(fingerprint: string, label = 'remote'): string {
  return `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=${label}\r\na=fingerprint:${fingerprint}\r\n`;
}

// Computed once, so a fake certificate is ready one microtask after it is asked for.
const PEER_FINGERPRINT = fakeFingerprint(0xab);
const PEER_FINGERPRINT_COMMITMENT = await computeFingerprintCommitment(PEER_FINGERPRINT);
const OTHER_FINGERPRINT = fakeFingerprint(0xcd);
const LOCAL_CERTIFICATES: LocalCertificate[] = await Promise.all(
  Array.from({ length: 16 }, async (_, certificateIndex) => ({
    certificate: { fakeCertificateNumber: certificateIndex } as unknown as RTCCertificate,
    fingerprint: fakeFingerprint(certificateIndex),
    fingerprintCommitment: await computeFingerprintCommitment(fakeFingerprint(certificateIndex)),
  })),
);

/** Lets a connection that is being opened (its certificate is ready) be created. */
async function flushOpening(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function startSession(
  signalKey?: CryptoKey,
  readIsPrivacyModeOn: () => boolean = () => false,
  prepareLocalCertificateOverride?: () => Promise<LocalCertificate>,
  /** Makes every createPeerConnection throw this, as a browser refusing the configuration. */
  createPeerConnectionError?: Error,
) {
  const roomSignalKey = await deriveSignalKey(roomSecretBytes);
  const peerConnections: ReturnType<typeof createMockPeerConnection>[] = [];
  const iceServersUsed: RTCIceServer[][] = [];
  const iceTransportPoliciesUsed: RTCIceTransportPolicy[] = [];
  const certificatesUsed: RTCCertificate[] = [];
  let preparedCertificateCount = 0;
  const prepareLocalCertificate = vi.fn(
    prepareLocalCertificateOverride ??
      (async () => {
        const localCertificate = LOCAL_CERTIFICATES[preparedCertificateCount];
        preparedCertificateCount += 1;
        if (localCertificate === undefined) throw new Error('out of fake certificates');
        return localCertificate;
      }),
  );
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
    onReconnecting: vi.fn(),
    onReconnected: vi.fn(),
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
    readIsPrivacyModeOn,
    createPeerConnection: (iceServers, iceTransportPolicy, certificate) => {
      if (createPeerConnectionError !== undefined) throw createPeerConnectionError;
      iceTransportPoliciesUsed.push(iceTransportPolicy);
      iceServersUsed.push(iceServers);
      certificatesUsed.push(certificate);
      const mockPeerConnection = createMockPeerConnection();
      peerConnections.push(mockPeerConnection);
      return mockPeerConnection as unknown as CallPeerConnection;
    },
    prepareLocalCertificate,
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
    iceTransportPoliciesUsed,
    certificatesUsed,
    prepareLocalCertificate,
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
 * (committing to PEER_FINGERPRINT) and later messages exactly like the real peer would
 * (encrypted, with the next seq).
 */
function createFakePeer(startedSession: StartedSession, signalKey = startedSession.roomSignalKey) {
  const { signalingClient, server } = startedSession;
  const peerSessionId = createSessionId();
  let nextPeerSequenceNumber = 0;
  let readSentCount = 0;
  let ourSessionId: Uint8Array | null = null;
  let nextOurSequenceNumber = 0;

  let ourFingerprintCommitment: string | null = null;

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
    ourFingerprintCommitment = hello.data.fingerprintCommitment;
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
    /** The commitment our hello carried, once `readOurHello` has run. */
    readOurFingerprintCommitment: () => ourFingerprintCommitment,
    async sendHello(fingerprintCommitment = PEER_FINGERPRINT_COMMITMENT) {
      const encrypted = await encryptSignalPayload({
        signalKey,
        signalPayload: {
          kind: 'hello',
          data: { sessionId: toBase64Url(peerSessionId), fingerprintCommitment },
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

const OFFER_DATA = { type: 'offer', sdp: sdpWithFingerprint(PEER_FINGERPRINT, 'offer') } as const;
const ANSWER_DATA = {
  type: 'answer',
  sdp: sdpWithFingerprint(PEER_FINGERPRINT, 'answer'),
} as const;

describe('call session', () => {
  it('the first peer waits for the other person before creating a connection', async () => {
    const { server, peerConnections } = await startSession();
    server().onJoined('first');
    expect(peerConnections).toHaveLength(0);
    server().onPeerJoined();
    await flushOpening();
    expect(peerConnections).toHaveLength(1);
  });

  it('sends only an encrypted hello at first and adds the local tracks after the peer hello', async () => {
    const startedSession = await startSession();
    const { server, peerConnections, localTrack, signalingClient } = startedSession;
    server().onJoined('second');
    await flushOpening();
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

  it('reads both descriptions only when both are set, and only with the committed fingerprints', async () => {
    const startedSession = await startConnectedSession();
    const { callSession, peerConnections, fakePeer } = startedSession;
    const peerConnection = peerConnections[0]!;
    await fakePeer.send({ kind: 'offer', data: OFFER_DATA }); // passes the commitment check
    await vi.waitFor(() => expect(peerConnection.setRemoteDescription).toHaveBeenCalled());
    expect(callSession.readSessionDescriptionSdps()).toBeNull();
    const localSdp = sdpWithFingerprint(LOCAL_CERTIFICATES[0]!.fingerprint, 'local');
    peerConnection.currentLocalDescription = { type: 'answer', sdp: localSdp } as never;
    expect(callSession.readSessionDescriptionSdps()).toBeNull();
    // The browser rebuilds the SDP it applied: still the committed fingerprint, so it counts.
    const remoteSdp = sdpWithFingerprint(PEER_FINGERPRINT.toLowerCase(), 'rebuilt');
    peerConnection.currentRemoteDescription = { type: 'offer', sdp: remoteSdp } as never;
    expect(callSession.readSessionDescriptionSdps()).toEqual({ localSdp, remoteSdp });
    expect(startedSession.sessionEvents.onSessionEnded).not.toHaveBeenCalled();
  });

  it('descriptions that show any other fingerprint end the call instead of feeding the code', async () => {
    for (const [localFingerprint, remoteFingerprint] of [
      [LOCAL_CERTIFICATES[0]!.fingerprint, OTHER_FINGERPRINT], // the browser uses another remote one
      [OTHER_FINGERPRINT, PEER_FINGERPRINT], // our connection does not use our certificate
    ]) {
      const startedSession = await startConnectedSession();
      const peerConnection = startedSession.peerConnections[0]!;
      await startedSession.fakePeer.send({ kind: 'offer', data: OFFER_DATA });
      await vi.waitFor(() => expect(peerConnection.setRemoteDescription).toHaveBeenCalled());
      peerConnection.currentLocalDescription = {
        type: 'answer',
        sdp: sdpWithFingerprint(localFingerprint!),
      } as never;
      peerConnection.currentRemoteDescription = {
        type: 'offer',
        sdp: sdpWithFingerprint(remoteFingerprint!),
      } as never;
      expect(startedSession.callSession.readSessionDescriptionSdps()).toBeNull();
      await expectVerificationFailure(startedSession);
    }
  });

  it('descriptions before any remote one passed the check end the call', async () => {
    const startedSession = await startSession();
    startedSession.server().onJoined('second');
    await flushOpening();
    const peerConnection = startedSession.peerConnections[0]!;
    peerConnection.currentLocalDescription = {
      type: 'answer',
      sdp: sdpWithFingerprint(LOCAL_CERTIFICATES[0]!.fingerprint),
    } as never;
    peerConnection.currentRemoteDescription = {
      type: 'offer',
      sdp: sdpWithFingerprint(PEER_FINGERPRINT),
    } as never;
    expect(startedSession.callSession.readSessionDescriptionSdps()).toBeNull();
    await expectVerificationFailure(startedSession);
  });

  it('ignores pending descriptions that are not the ones in use yet', async () => {
    const { callSession, server, peerConnections } = await startSession();
    server().onJoined('second');
    await flushOpening();
    const peerConnection = peerConnections[0]!;
    peerConnection.localDescription = { type: 'offer', sdp: 'pending-local' } as never;
    peerConnection.remoteDescription = { type: 'answer', sdp: 'pending-remote' } as never;
    expect(callSession.readSessionDescriptionSdps()).toBeNull();
  });

  it('announces every new peer connection with a new number, so "verified" cannot carry over', async () => {
    const { server, sessionEvents } = await startSession();
    server().onJoined('first');
    server().onPeerJoined();
    await flushOpening();
    server().onPeerLeft();
    server().onPeerJoined(); // someone else arrives with the same link
    await flushOpening();
    const [firstNumber, secondNumber] = sessionEvents.onPeerConnectionOpened.mock.calls.map(
      (call) => call[0] as number,
    );
    expect(secondNumber).toBe(firstNumber! + 1);

    // A brand-new session must not start counting from the beginning again.
    const nextSession = await startSession();
    nextSession.server().onJoined('second');
    await flushOpening();
    expect(nextSession.sessionEvents.onPeerConnectionOpened).toHaveBeenCalledWith(
      secondNumber! + 1,
    );
  });

  it('tells the page to read the descriptions again whenever the connection is stable again', async () => {
    const { server, peerConnections, sessionEvents } = await startSession();
    server().onJoined('second');
    await flushOpening();
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
    await flushOpening();
    callSession.hangUp();
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(signalingClient.leaveAndClose).toHaveBeenCalled();
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('hung-up');
    expect(callSession.readSessionDescriptionSdps()).toBeNull();
  });

  it('replaces only the video sender track, without renegotiating (camera switch)', async () => {
    const { callSession, server, peerConnections } = await startSession();
    server().onJoined('second');
    await flushOpening();
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
    await flushOpening();
    server().onPeerLeft();
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(sessionEvents.onRemoteMediaStream).toHaveBeenLastCalledWith(null);
  });

  it('a replacement peer joining closes the previous connection', async () => {
    const { server, peerConnections } = await startSession();
    server().onJoined('first');
    server().onPeerJoined();
    await flushOpening();
    server().onPeerJoined();
    await flushOpening();
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
    await flushOpening();
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
      data: {
        sessionId: toBase64Url(createSessionId()),
        fingerprintCommitment: PEER_FINGERPRINT_COMMITMENT,
      },
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
    await flushOpening();
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
      await flushOpening();
      expect(iceServersUsed).toEqual([buildIceServers(turnCredentials)]);
      expect(iceServersUsed[0]![0]).toMatchObject({
        username: turnCredentials.username,
        credential: turnCredentials.credential,
      });
    });

    it('uses STUN only after joined without turn', async () => {
      const { server, iceServersUsed } = await startSession();
      server().onJoined('second');
      await flushOpening();
      expect(iceServersUsed).toEqual([PUBLIC_STUN_ICE_SERVERS]);
    });

    it('the person who gets peer-joined uses the credentials from their own joined', async () => {
      const { server, iceServersUsed } = await startSession();
      server().onJoined('first', turnCredentials);
      expect(iceServersUsed).toHaveLength(0);
      server().onPeerJoined();
      await flushOpening();
      server().onPeerLeft();
      server().onPeerJoined();
      await flushOpening();
      expect(iceServersUsed).toEqual([
        buildIceServers(turnCredentials),
        buildIceServers(turnCredentials),
      ]);
    });

    describe('privacy mode', () => {
      const RELAY_CANDIDATE = 'candidate:3 1 udp 41885439 198.51.100.7 60000 typ relay';
      const HOST_CANDIDATE = 'candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host';
      const SRFLX_CANDIDATE = 'candidate:2 1 udp 1686052607 203.0.113.9 50000 typ srflx';

      it('uses only the TURN server and iceTransportPolicy relay', async () => {
        const { server, iceServersUsed, iceTransportPoliciesUsed } = await startSession(
          undefined,
          () => true,
        );
        server().onJoined('second', turnCredentials);
        await flushOpening();
        expect(iceTransportPoliciesUsed).toEqual(['relay']);
        expect(iceServersUsed).toHaveLength(1);
        expect(iceServersUsed[0]).toEqual([
          {
            urls: turnCredentials.urls,
            username: turnCredentials.username,
            credential: turnCredentials.credential,
          },
        ]);
      });

      it('never sends a host or srflx candidate, only relay', async () => {
        const startedSession = await startSession(undefined, () => true);
        startedSession.server().onJoined('second', turnCredentials);
        await flushOpening();
        const peerConnection = startedSession.peerConnections[0]!;
        const fakePeer = createFakePeer(startedSession);
        await fakePeer.readOurHello();
        await fakePeer.sendHello();
        await vi.waitFor(() => expect(peerConnection.addTrack).toHaveBeenCalled());
        for (const candidate of [HOST_CANDIDATE, SRFLX_CANDIDATE, RELAY_CANDIDATE]) {
          peerConnection.onicecandidate?.({
            candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abc' },
          } as RTCPeerConnectionIceEvent);
        }
        await vi.waitFor(() =>
          expect(startedSession.signalingClient.sendSignal).toHaveBeenCalledTimes(2),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        // hello + the relay candidate; nothing for host and srflx
        expect(startedSession.signalingClient.sendSignal).toHaveBeenCalledTimes(2);
      });

      it('no turn: creates no peer connection, shows the reason and does not retry', async () => {
        const {
          server,
          peerConnections,
          sessionEvents,
          signalingClient,
          iceTransportPoliciesUsed,
        } = await startSession(undefined, () => true);
        server().onJoined('second');
        expect(peerConnections).toHaveLength(0);
        expect(iceTransportPoliciesUsed).toHaveLength(0);
        expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('privacy-mode-needs-relay');
        expect(signalingClient.leaveAndClose).toHaveBeenCalled();
        server().onPeerJoined();
        expect(peerConnections).toHaveLength(0);
      });

      it('turn without URLs counts as no turn', async () => {
        const { server, peerConnections, sessionEvents } = await startSession(
          undefined,
          () => true,
        );
        server().onJoined('first', { ...turnCredentials, urls: [] });
        server().onPeerJoined();
        expect(peerConnections).toHaveLength(0);
        expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('privacy-mode-needs-relay');
      });

      it('off: unchanged (all candidates, STUN, candidates are sent)', async () => {
        const startedSession = await startSession(undefined, () => false);
        startedSession.server().onJoined('second', turnCredentials);
        await flushOpening();
        expect(startedSession.iceTransportPoliciesUsed).toEqual(['all']);
        expect(startedSession.iceServersUsed).toEqual([buildIceServers(turnCredentials)]);
        const fakePeer = createFakePeer(startedSession);
        await fakePeer.readOurHello();
        await fakePeer.sendHello();
        await vi.waitFor(() =>
          expect(startedSession.peerConnections[0]!.addTrack).toHaveBeenCalled(),
        );
        startedSession.peerConnections[0]!.onicecandidate?.({
          candidate: { candidate: HOST_CANDIDATE, sdpMid: '0', sdpMLineIndex: 0 },
        } as RTCPeerConnectionIceEvent);
        await vi.waitFor(() =>
          expect(startedSession.signalingClient.sendSignal).toHaveBeenCalledTimes(2),
        );
      });

      it('is read again for every new peer connection, also when the other person rejoins', async () => {
        let isPrivacyModeOn = false;
        const startedSession = await startSession(undefined, () => isPrivacyModeOn);
        startedSession.server().onJoined('first', turnCredentials);
        startedSession.server().onPeerJoined();
        await flushOpening();
        isPrivacyModeOn = true; // changed mid-call: this connection stays as it is
        expect(startedSession.iceTransportPoliciesUsed).toEqual(['all']);
        startedSession.server().onPeerLeft();
        startedSession.server().onPeerJoined(); // next connection honours it, using the TURN kept
        await flushOpening();
        expect(startedSession.iceTransportPoliciesUsed).toEqual(['all', 'relay']);
        expect(startedSession.sessionEvents.onSessionEnded).not.toHaveBeenCalled();
      });

      it('a rejoining peer after privacy mode was turned on, without turn, ends the call', async () => {
        let isPrivacyModeOn = false;
        const startedSession = await startSession(undefined, () => isPrivacyModeOn);
        startedSession.server().onJoined('first'); // no turn
        startedSession.server().onPeerJoined();
        await flushOpening();
        isPrivacyModeOn = true;
        startedSession.server().onPeerLeft();
        startedSession.server().onPeerJoined();
        expect(startedSession.peerConnections).toHaveLength(1);
        expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalledWith(
          'privacy-mode-needs-relay',
        );
      });
    });

    it('never puts the credential into a session problem', async () => {
      const startedSession = await startSession();
      startedSession.server().onJoined('second', turnCredentials);
      await flushOpening();
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

describe('call session: the DTLS fingerprint is committed in the hello (issue #94)', () => {
  /** A peer connection that has sent its own offer, so an answer can be applied. */
  async function startSessionWaitingForAnswer() {
    const startedSession = await startConnectedSession();
    const peerConnection = startedSession.peerConnections[0]!;
    peerConnection.setLocalDescription.mockImplementation(async () => {
      peerConnection.localDescription = { type: 'offer', sdp: 'my-offer' } as never;
      peerConnection.signalingState = 'have-local-offer';
    });
    peerConnection.onnegotiationneeded?.(new Event('negotiationneeded'));
    expect((await startedSession.fakePeer.readNextSentPayload()).kind).toBe('offer');
    return startedSession;
  }

  it('our hello commits to the fingerprint of the certificate made for that connection', async () => {
    const startedSession = await startSession();
    startedSession.server().onJoined('second');
    const fakePeer = createFakePeer(startedSession);
    await fakePeer.readOurHello();
    expect(fakePeer.readOurFingerprintCommitment()).toBe(
      LOCAL_CERTIFICATES[0]!.fingerprintCommitment,
    );
    expect(startedSession.certificatesUsed).toEqual([LOCAL_CERTIFICATES[0]!.certificate]);
  });

  it('every new peer connection gets a new certificate, never a reused one', async () => {
    const { server, certificatesUsed, prepareLocalCertificate } = await startSession();
    server().onJoined('first');
    server().onPeerJoined();
    await flushOpening();
    server().onPeerLeft();
    server().onPeerJoined(); // the other person comes back: a new connection, a new certificate
    await flushOpening();
    expect(prepareLocalCertificate).toHaveBeenCalledTimes(2);
    expect(certificatesUsed).toEqual([
      LOCAL_CERTIFICATES[0]!.certificate,
      LOCAL_CERTIFICATES[1]!.certificate,
    ]);
  });

  it('applies an offer or an answer that carries the committed fingerprint', async () => {
    const offered = await startConnectedSession();
    await offered.fakePeer.send({ kind: 'offer', data: OFFER_DATA });
    await vi.waitFor(() =>
      expect(offered.peerConnections[0]!.setRemoteDescription).toHaveBeenCalledWith(OFFER_DATA),
    );

    const answered = await startSessionWaitingForAnswer();
    await answered.fakePeer.send({ kind: 'answer', data: ANSWER_DATA });
    await vi.waitFor(() =>
      expect(answered.peerConnections[0]!.setRemoteDescription).toHaveBeenCalledWith(ANSWER_DATA),
    );
    expect(offered.sessionEvents.onSessionEnded).not.toHaveBeenCalled();
    expect(answered.sessionEvents.onSessionEnded).not.toHaveBeenCalled();
  });

  it('the committed fingerprint written in lower case is the same fingerprint', async () => {
    const { fakePeer, peerConnections, sessionEvents } = await startConnectedSession();
    const lowerCaseOffer = {
      type: 'offer',
      sdp: sdpWithFingerprint(PEER_FINGERPRINT.toLowerCase()),
    } as const;
    await fakePeer.send({ kind: 'offer', data: lowerCaseOffer });
    await vi.waitFor(() => expect(peerConnections[0]!.setRemoteDescription).toHaveBeenCalled());
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
  });

  it('an offer with another, no, several or a malformed fingerprint ends the call before it is applied', async () => {
    for (const sdp of [
      sdpWithFingerprint(OTHER_FINGERPRINT),
      'v=0\r\ns=no fingerprint\r\n',
      `${sdpWithFingerprint(PEER_FINGERPRINT)}a=fingerprint:${OTHER_FINGERPRINT}\r\n`,
      sdpWithFingerprint('sha-256 AB:CD'),
      sdpWithFingerprint(PEER_FINGERPRINT.replace('sha-256', 'sha-1')),
    ]) {
      const startedSession = await startConnectedSession();
      await startedSession.fakePeer.send({ kind: 'offer', data: { type: 'offer', sdp } });
      await expectVerificationFailure(startedSession);
      expect(startedSession.peerConnections[0]!.setRemoteDescription).not.toHaveBeenCalled();
    }
  });

  it('an answer with another fingerprint ends the call before it is applied', async () => {
    const startedSession = await startSessionWaitingForAnswer();
    await startedSession.fakePeer.send({
      kind: 'answer',
      data: { type: 'answer', sdp: sdpWithFingerprint(OTHER_FINGERPRINT, 'answer') },
    });
    await expectVerificationFailure(startedSession);
    expect(startedSession.peerConnections[0]!.setRemoteDescription).not.toHaveBeenCalled();
  });

  it('a renegotiation offer that changes the fingerprint ends the call', async () => {
    const startedSession = await startConnectedSession();
    const peerConnection = startedSession.peerConnections[0]!;
    await startedSession.fakePeer.send({ kind: 'offer', data: OFFER_DATA });
    await vi.waitFor(() => expect(peerConnection.setRemoteDescription).toHaveBeenCalledTimes(1));
    await startedSession.fakePeer.send({
      kind: 'offer',
      data: { type: 'offer', sdp: sdpWithFingerprint(OTHER_FINGERPRINT) },
    });
    await expectVerificationFailure(startedSession);
    expect(peerConnection.setRemoteDescription).toHaveBeenCalledTimes(1);
  });

  it('a hello without a commitment, or with a malformed one, ends the call', async () => {
    const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const lastCharacter = PEER_FINGERPRINT_COMMITMENT.at(-1)!;
    // Same 32 bytes, but the unused low bits of the last character are set: not canonical.
    const nonCanonicalCommitment =
      PEER_FINGERPRINT_COMMITMENT.slice(0, -1) +
      base64UrlAlphabet[base64UrlAlphabet.indexOf(lastCharacter) + 1];
    for (const helloData of [
      { sessionId: toBase64Url(createSessionId()) },
      { sessionId: toBase64Url(createSessionId()), fingerprintCommitment: 'too-short' },
      { sessionId: toBase64Url(createSessionId()), fingerprintCommitment: nonCanonicalCommitment },
    ]) {
      const startedSession = await startSession();
      startedSession.server().onJoined('second');
      await createFakePeer(startedSession).readOurHello();
      // Encrypted correctly with the room key, as someone with the link could: only the
      // contents are wrong.
      const { ciphertextBytes, ivBytes } = await encryptSignalBytes({
        signalKey: startedSession.roomSignalKey,
        plaintextBytes: new TextEncoder().encode(
          JSON.stringify({ kind: 'hello', data: helloData, seq: 0 }),
        ),
        additionalData: buildHelloAad(0),
      });
      startedSession.server().onSignal(toBase64(ciphertextBytes), toBase64(ivBytes));
      await expectVerificationFailure(startedSession);
      expect(startedSession.peerConnections[0]!.addTrack).not.toHaveBeenCalled();
    }
  });

  it('a hello that commits to our own fingerprint ends the call', async () => {
    const startedSession = await startSession();
    startedSession.server().onJoined('second');
    const fakePeer = createFakePeer(startedSession);
    await fakePeer.readOurHello();
    await fakePeer.sendHello(fakePeer.readOurFingerprintCommitment()!);
    await expectVerificationFailure(startedSession);
    expect(startedSession.peerConnections[0]!.addTrack).not.toHaveBeenCalled();
  });

  it('by default each RTCPeerConnection is created with its own certificate, and only that one', async () => {
    const configurations: RTCConfiguration[] = [];
    class StubPeerConnection {
      constructor(configuration: RTCConfiguration) {
        configurations.push(configuration);
        Object.assign(this, createMockPeerConnection());
      }
    }
    vi.stubGlobal('RTCPeerConnection', StubPeerConnection);
    try {
      const roomSignalKey = await deriveSignalKey(roomSecretBytes);
      let signalingEvents: SignalingClientEvents | null = null;
      let preparedCount = 0;
      startCallSession({
        roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
        signalKey: roomSignalKey,
        signalingUrl: 'ws://localhost:8000/ws/signal/',
        localMediaStream: { getTracks: () => [] } as unknown as MediaStream,
        events: {
          onPeerConnectionOpened: vi.fn(),
          onRemoteMediaStream: vi.fn(),
          onPeerConnectionStateChange: vi.fn(),
          onSessionDescriptionsMayHaveChanged: vi.fn(),
          onSessionProblem: vi.fn(),
          onReconnecting: vi.fn(),
          onReconnected: vi.fn(),
          onSessionEnded: vi.fn(),
        },
        prepareLocalCertificate: async () => LOCAL_CERTIFICATES[preparedCount++]!,
        connectToSignaling: ((connectionOptions: { events: SignalingClientEvents }) => {
          signalingEvents = connectionOptions.events;
          return { sendSignal: vi.fn(), leaveAndClose: vi.fn() };
        }) as never,
      });
      signalingEvents!.onJoined('first');
      signalingEvents!.onPeerJoined();
      await flushOpening();
      signalingEvents!.onPeerLeft();
      signalingEvents!.onPeerJoined();
      await flushOpening();
      expect(configurations.map((configuration) => configuration.certificates)).toEqual([
        [LOCAL_CERTIFICATES[0]!.certificate],
        [LOCAL_CERTIFICATES[1]!.certificate],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('while the certificate for a new connection is being made', () => {
    function startSessionWithHeldCertificate() {
      let releaseCertificate: ((localCertificate: LocalCertificate) => void) | null = null;
      let failCertificate: ((certificateError: Error) => void) | null = null;
      const startedSession = startSession(
        undefined,
        undefined,
        () =>
          new Promise<LocalCertificate>((resolve, reject) => {
            releaseCertificate = resolve;
            failCertificate = reject;
          }),
      );
      return {
        startedSession,
        release: () => releaseCertificate!(LOCAL_CERTIFICATES[0]!),
        fail: () => failCertificate!(new Error('no certificate')),
      };
    }

    it("the other side's hello waits for the connection and is then accepted", async () => {
      const held = startSessionWithHeldCertificate();
      const startedSession = await held.startedSession;
      startedSession.server().onJoined('second');
      await flushOpening();
      const fakePeer = createFakePeer(startedSession);
      await fakePeer.sendHello(); // arrives before our connection exists
      await flushOpening();
      expect(startedSession.peerConnections).toHaveLength(0);
      expect(startedSession.sessionEvents.onSessionEnded).not.toHaveBeenCalled();
      held.release();
      await fakePeer.readOurHello();
      await vi.waitFor(() =>
        expect(startedSession.peerConnections[0]!.addTrack).toHaveBeenCalled(),
      );
      expect(startedSession.sessionEvents.onSessionEnded).not.toHaveBeenCalled();
    });

    it('a second signal before the connection exists ends the call', async () => {
      const held = startSessionWithHeldCertificate();
      const startedSession = await held.startedSession;
      startedSession.server().onJoined('second');
      const fakePeer = createFakePeer(startedSession);
      await fakePeer.sendHello();
      await fakePeer.sendHello();
      await expectVerificationFailure(startedSession);
      held.release();
      await flushOpening();
      expect(startedSession.peerConnections).toHaveLength(0);
      expect(startedSession.signalingClient.sendSignal).not.toHaveBeenCalled();
    });

    it('the other person leaving, or hanging up, cancels the connection', async () => {
      const left = startSessionWithHeldCertificate();
      const leftSession = await left.startedSession;
      leftSession.server().onJoined('first');
      leftSession.server().onPeerJoined();
      leftSession.server().onPeerLeft();
      left.release();
      await flushOpening();
      expect(leftSession.peerConnections).toHaveLength(0);
      expect(leftSession.signalingClient.sendSignal).not.toHaveBeenCalled();

      const hungUp = startSessionWithHeldCertificate();
      const hungUpSession = await hungUp.startedSession;
      hungUpSession.server().onJoined('second');
      hungUpSession.callSession.hangUp();
      hungUp.release();
      await flushOpening();
      expect(hungUpSession.peerConnections).toHaveLength(0);
      expect(hungUpSession.sessionEvents.onSessionEnded).toHaveBeenCalledWith('hung-up');
    });

    /** Certificates that resolve or fail only when the test says so, one per opening. */
    async function startSessionWithHeldCertificates() {
      const held: {
        resolve: (localCertificate: LocalCertificate) => void;
        reject: (certificateError: Error) => void;
      }[] = [];
      const startedSession = await startSession(
        undefined,
        undefined,
        () =>
          new Promise<LocalCertificate>((resolve, reject) => {
            held.push({ resolve, reject });
          }),
      );
      return { startedSession, held };
    }

    it('a newer opening wins whichever certificate is ready first', async () => {
      for (const order of ['older first', 'newer first'] as const) {
        const { startedSession, held } = await startSessionWithHeldCertificates();
        startedSession.server().onJoined('first');
        startedSession.server().onPeerJoined();
        startedSession.server().onPeerJoined(); // a replacement arrives before the first opened
        expect(held).toHaveLength(2);
        const [older, newer] = held;
        if (order === 'older first') {
          older!.resolve(LOCAL_CERTIFICATES[0]!);
          await flushOpening();
          newer!.resolve(LOCAL_CERTIFICATES[1]!);
        } else {
          newer!.resolve(LOCAL_CERTIFICATES[1]!);
          await flushOpening();
          older!.resolve(LOCAL_CERTIFICATES[0]!);
        }
        await flushOpening();
        expect(startedSession.certificatesUsed, order).toEqual([
          LOCAL_CERTIFICATES[1]!.certificate,
        ]);
        expect(startedSession.peerConnections, order).toHaveLength(1);
        expect(startedSession.sessionEvents.onSessionEnded, order).not.toHaveBeenCalled();
      }
    });

    it('an older certificate that fails late does not end the newer connection', async () => {
      for (const order of ['while the newer is pending', 'after the newer opened'] as const) {
        const { startedSession, held } = await startSessionWithHeldCertificates();
        startedSession.server().onJoined('first');
        startedSession.server().onPeerJoined();
        startedSession.server().onPeerJoined();
        const [older, newer] = held;
        if (order === 'while the newer is pending') {
          older!.reject(new Error('late failure'));
          await flushOpening();
          newer!.resolve(LOCAL_CERTIFICATES[1]!);
        } else {
          newer!.resolve(LOCAL_CERTIFICATES[1]!);
          await flushOpening();
          older!.reject(new Error('late failure'));
        }
        await flushOpening();
        expect(startedSession.peerConnections, order).toHaveLength(1);
        expect(startedSession.sessionEvents.onSessionEnded, order).not.toHaveBeenCalled();
      }
    });

    it('a connection that cannot be created ends the call, without a hello', async () => {
      const createPeerConnectionError = new SyntaxError('bad ICE server URL');
      const startedSession = await startSession(
        undefined,
        undefined,
        undefined,
        createPeerConnectionError,
      );
      const { server, sessionEvents, signalingClient } = startedSession;
      server().onJoined('second');
      await vi.waitFor(() =>
        expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('message-not-sent'),
      );
      expect(sessionEvents.onSessionProblem).toHaveBeenCalledWith(createPeerConnectionError);
      expect(signalingClient.leaveAndClose).toHaveBeenCalled();
      expect(signalingClient.sendSignal).not.toHaveBeenCalled();
    });

    it('a certificate that cannot be made ends the call, without a connection or a hello', async () => {
      const held = startSessionWithHeldCertificate();
      const startedSession = await held.startedSession;
      startedSession.server().onJoined('second');
      await flushOpening();
      held.fail();
      await vi.waitFor(() =>
        expect(startedSession.sessionEvents.onSessionEnded).toHaveBeenCalledWith(
          'message-not-sent',
        ),
      );
      expect(startedSession.sessionEvents.onSessionProblem).toHaveBeenCalled();
      expect(startedSession.signalingClient.leaveAndClose).toHaveBeenCalled();
      expect(startedSession.peerConnections).toHaveLength(0);
      expect(startedSession.signalingClient.sendSignal).not.toHaveBeenCalled();
    });
  });
});
