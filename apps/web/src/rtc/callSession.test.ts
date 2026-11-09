import { describe, expect, it, vi } from 'vitest';
import { startCallSession, type CallPeerConnection } from '@/rtc/callSession';
import { decodeSignalPayload, encodeSignalPayload } from '@/rtc/signalPayloadCodec';
import type { SignalingClientEvents } from '@/signaling/signalingClient';

function createMockPeerConnection() {
  return {
    signalingState: 'stable',
    localDescription: null,
    remoteDescription: null,
    currentLocalDescription: null,
    currentRemoteDescription: null,
    connectionState: 'new',
    onnegotiationneeded: null,
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

function startSession() {
  const peerConnections: ReturnType<typeof createMockPeerConnection>[] = [];
  const signalingClient = {
    sendSignal: vi.fn<(payload: string) => void>(),
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
    signalingUrl: 'ws://localhost:8000/ws/signal/',
    localMediaStream,
    events: sessionEvents,
    createPeerConnection: () => {
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
  return { callSession, peerConnections, signalingClient, sessionEvents, server, localTrack };
}

const OFFER_DATA = { type: 'offer', sdp: 'remote-offer-sdp' } as const;

describe('call session', () => {
  it('the first peer waits for the other person before creating a connection', () => {
    const { server, peerConnections } = startSession();
    server().onJoined('first');
    expect(peerConnections).toHaveLength(0);
    server().onPeerJoined();
    expect(peerConnections).toHaveLength(1);
  });

  it('the second peer creates a connection at once and adds its local tracks', () => {
    const { server, peerConnections, localTrack } = startSession();
    server().onJoined('second');
    expect(peerConnections).toHaveLength(1);
    expect(peerConnections[0]!.addTrack).toHaveBeenCalledWith(localTrack, expect.anything());
  });

  it('feeds a valid remote offer to the connection and sends the answer back as a payload', async () => {
    const { server, peerConnections, signalingClient } = startSession();
    server().onJoined('second');
    const peerConnection = peerConnections[0]!;
    peerConnection.setRemoteDescription.mockImplementation(async () => {
      peerConnection.signalingState = 'have-remote-offer';
    });
    peerConnection.setLocalDescription.mockImplementation(async () => {
      peerConnection.localDescription = { type: 'answer', sdp: 'my-answer' } as never;
    });
    server().onSignal(encodeSignalPayload({ kind: 'offer', data: OFFER_DATA, seq: 0 }), null);
    await vi.waitFor(() => expect(signalingClient.sendSignal).toHaveBeenCalled());
    expect(peerConnection.setRemoteDescription).toHaveBeenCalledWith(OFFER_DATA);
    const sentPayload = decodeSignalPayload(signalingClient.sendSignal.mock.calls[0]![0]);
    expect(sentPayload).toEqual({
      kind: 'answer',
      data: { type: 'answer', sdp: 'my-answer' },
      seq: 0,
    });
  });

  it('reads both descriptions only when both are set', () => {
    const { callSession, server, peerConnections } = startSession();
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

  it('ignores pending descriptions that are not the ones in use yet', () => {
    const { callSession, server, peerConnections } = startSession();
    server().onJoined('second');
    const peerConnection = peerConnections[0]!;
    peerConnection.localDescription = { type: 'offer', sdp: 'pending-local' } as never;
    peerConnection.remoteDescription = { type: 'answer', sdp: 'pending-remote' } as never;
    expect(callSession.readSessionDescriptionSdps()).toBeNull();
  });

  it('announces every new peer connection with a new number, so "verified" cannot carry over', () => {
    const { server, sessionEvents } = startSession();
    server().onJoined('first');
    server().onPeerJoined();
    server().onPeerLeft();
    server().onPeerJoined(); // someone else arrives with the same link
    const [firstNumber, secondNumber] = sessionEvents.onPeerConnectionOpened.mock.calls.map(
      (call) => call[0] as number,
    );
    expect(secondNumber).toBe(firstNumber! + 1);

    // A brand-new session must not start counting from the beginning again.
    const nextSession = startSession();
    nextSession.server().onJoined('second');
    expect(nextSession.sessionEvents.onPeerConnectionOpened).toHaveBeenCalledWith(
      secondNumber! + 1,
    );
  });

  it('tells the page to read the descriptions again whenever the connection is stable again', () => {
    const { server, peerConnections, sessionEvents } = startSession();
    server().onJoined('second');
    const peerConnection = peerConnections[0]!;
    peerConnection.signalingState = 'have-remote-offer';
    peerConnection.onsignalingstatechange?.();
    expect(sessionEvents.onSessionDescriptionsMayHaveChanged).not.toHaveBeenCalled();
    peerConnection.signalingState = 'stable';
    peerConnection.onsignalingstatechange?.();
    expect(sessionEvents.onSessionDescriptionsMayHaveChanged).toHaveBeenCalledTimes(1);
  });

  it('hanging up (what "No, the codes differ" does) closes the connection and the socket', () => {
    const { callSession, server, peerConnections, signalingClient, sessionEvents } = startSession();
    server().onJoined('second');
    callSession.hangUp();
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(signalingClient.leaveAndClose).toHaveBeenCalled();
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('hung-up');
    expect(callSession.readSessionDescriptionSdps()).toBeNull();
  });

  it('drops a replayed payload', async () => {
    const { server, peerConnections } = startSession();
    server().onJoined('second');
    const replayedText = encodeSignalPayload({ kind: 'offer', data: OFFER_DATA, seq: 0 });
    server().onSignal(replayedText, null);
    server().onSignal(replayedText, null);
    await vi.waitFor(() =>
      expect(peerConnections[0]!.setRemoteDescription).toHaveBeenCalledTimes(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(peerConnections[0]!.setRemoteDescription).toHaveBeenCalledTimes(1);
  });

  it('drops garbage payloads and payloads that carry an iv', async () => {
    const { server, peerConnections, sessionEvents } = startSession();
    server().onJoined('second');
    server().onSignal('QUJD', null);
    server().onSignal(
      encodeSignalPayload({ kind: 'offer', data: OFFER_DATA, seq: 0 }),
      'AAAAAAAAAAAAAAAA',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(peerConnections[0]!.setRemoteDescription).not.toHaveBeenCalled();
    expect(sessionEvents.onSessionEnded).not.toHaveBeenCalled();
  });

  it('drops signals that arrive when there is no connection', () => {
    const { server, sessionEvents } = startSession();
    server().onJoined('first');
    server().onSignal(encodeSignalPayload({ kind: 'offer', data: OFFER_DATA, seq: 0 }), null);
    expect(sessionEvents.onSessionProblem).not.toHaveBeenCalled();
  });

  it('closes the connection and clears the remote stream when the peer leaves', () => {
    const { server, peerConnections, sessionEvents } = startSession();
    server().onJoined('first');
    server().onPeerJoined();
    server().onPeerLeft();
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(sessionEvents.onRemoteMediaStream).toHaveBeenLastCalledWith(null);
  });

  it('starts from a fresh connection and sequence numbers when the peer rejoins', async () => {
    const { server, peerConnections } = startSession();
    server().onJoined('first');
    server().onPeerJoined();
    server().onSignal(
      encodeSignalPayload({ kind: 'answer', data: { type: 'answer', sdp: 'a' }, seq: 7 }),
      null,
    );
    server().onPeerLeft();
    server().onPeerJoined();
    expect(peerConnections).toHaveLength(2);
    // seq 0 would be a replay on the old connection, but the new peer starts over.
    server().onSignal(encodeSignalPayload({ kind: 'offer', data: OFFER_DATA, seq: 0 }), null);
    await vi.waitFor(() => expect(peerConnections[1]!.setRemoteDescription).toHaveBeenCalled());
  });

  it('a replacement peer joining closes the previous connection', () => {
    const { server, peerConnections } = startSession();
    server().onJoined('first');
    server().onPeerJoined();
    server().onPeerJoined();
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(peerConnections).toHaveLength(2);
  });

  it('closes the connection when the peer says bye', () => {
    const { server, peerConnections } = startSession();
    server().onJoined('first');
    server().onPeerJoined();
    server().onSignal(encodeSignalPayload({ kind: 'bye', data: null, seq: 0 }), null);
    expect(peerConnections[0]!.close).toHaveBeenCalled();
  });

  it('forwards the remote stream from ontrack', () => {
    const { server, peerConnections, sessionEvents } = startSession();
    server().onJoined('second');
    const remoteMediaStream = {} as MediaStream;
    peerConnections[0]!.ontrack?.({ streams: [remoteMediaStream] } as never);
    expect(sessionEvents.onRemoteMediaStream).toHaveBeenCalledWith(remoteMediaStream);
  });

  it('ends the session when the room is full', () => {
    const { server, sessionEvents } = startSession();
    server().onServerError('room-full');
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('room-full');
  });

  it('ends the session on rate-limited and bad-message errors', () => {
    for (const errorCode of ['rate-limited', 'bad-message'] as const) {
      const { server, sessionEvents } = startSession();
      server().onServerError(errorCode);
      expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('signaling-connection-lost');
    }
  });

  it('ends the session when the signaling server sends an invalid message', () => {
    const { server, sessionEvents } = startSession();
    server().onClosed('invalid-server-message');
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('invalid-signaling-message');
  });

  it('hang up says bye, leaves the room and ends once', () => {
    const { callSession, server, peerConnections, signalingClient, sessionEvents } = startSession();
    server().onJoined('first');
    server().onPeerJoined();
    callSession.hangUp();
    callSession.hangUp();
    const byePayload = decodeSignalPayload(signalingClient.sendSignal.mock.calls[0]![0]);
    expect(byePayload?.kind).toBe('bye');
    expect(signalingClient.leaveAndClose).toHaveBeenCalledTimes(1);
    expect(peerConnections[0]!.close).toHaveBeenCalled();
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(sessionEvents.onSessionEnded).toHaveBeenCalledWith('hung-up');
  });
});
