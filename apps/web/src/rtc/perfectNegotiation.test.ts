import { describe, expect, it, vi } from 'vitest';
import { startPerfectNegotiation, type NegotiablePeerConnection } from '@/rtc/perfectNegotiation';

/** A minimal stand-in for RTCPeerConnection that follows the signaling-state rules we rely on. */
function createMockPeerConnection() {
  const mockPeerConnection = {
    signalingState: 'stable' as RTCSignalingState,
    localDescription: null as RTCSessionDescription | null,
    onnegotiationneeded: null as NegotiablePeerConnection['onnegotiationneeded'],
    onicecandidate: null as NegotiablePeerConnection['onicecandidate'],
    setLocalDescription: vi.fn(async () => {
      const isAnswering = mockPeerConnection.signalingState === 'have-remote-offer';
      mockPeerConnection.localDescription = {
        type: isAnswering ? 'answer' : 'offer',
        sdp: isAnswering ? 'local-answer-sdp' : 'local-offer-sdp',
      } as RTCSessionDescription;
      mockPeerConnection.signalingState = isAnswering ? 'stable' : 'have-local-offer';
    }),
    setRemoteDescription: vi.fn(async (remoteDescription: RTCSessionDescriptionInit) => {
      if (remoteDescription.type === 'offer') {
        // Accepting an offer while we have our own pending offer implicitly rolls ours back.
        mockPeerConnection.signalingState = 'have-remote-offer';
      } else {
        if (mockPeerConnection.signalingState !== 'have-local-offer') {
          throw new Error('answer in wrong state');
        }
        mockPeerConnection.signalingState = 'stable';
      }
    }),
    addIceCandidate: vi.fn(async () => {}),
  };
  return mockPeerConnection;
}

function startNegotiation(isPolite: boolean) {
  const mockPeerConnection = createMockPeerConnection();
  const sendPayload = vi.fn();
  const onNegotiationError = vi.fn();
  const negotiation = startPerfectNegotiation({
    peerConnection: mockPeerConnection as unknown as NegotiablePeerConnection,
    isPolite,
    sendPayload,
    onNegotiationError,
  });
  return { mockPeerConnection, sendPayload, onNegotiationError, negotiation };
}

const REMOTE_OFFER = {
  kind: 'offer',
  data: { type: 'offer', sdp: 'remote-offer-sdp' },
  seq: 0,
} as const;
const REMOTE_ANSWER = {
  kind: 'answer',
  data: { type: 'answer', sdp: 'remote-answer-sdp' },
  seq: 1,
} as const;

describe('perfect negotiation', () => {
  it('sends an offer when negotiation is needed', async () => {
    const { mockPeerConnection, sendPayload } = startNegotiation(false);
    await mockPeerConnection.onnegotiationneeded?.(new Event('negotiationneeded'));
    expect(sendPayload).toHaveBeenCalledWith({
      kind: 'offer',
      data: { type: 'offer', sdp: 'local-offer-sdp' },
    });
  });

  it('answers a remote offer', async () => {
    const { mockPeerConnection, sendPayload, negotiation } = startNegotiation(false);
    await negotiation.handleRemotePayload(REMOTE_OFFER);
    expect(mockPeerConnection.setRemoteDescription).toHaveBeenCalledWith(REMOTE_OFFER.data);
    expect(sendPayload).toHaveBeenCalledWith({
      kind: 'answer',
      data: { type: 'answer', sdp: 'local-answer-sdp' },
    });
  });

  it('applies a remote answer to our offer', async () => {
    const { mockPeerConnection, negotiation, onNegotiationError } = startNegotiation(false);
    await mockPeerConnection.onnegotiationneeded?.(new Event('negotiationneeded'));
    await negotiation.handleRemotePayload(REMOTE_ANSWER);
    expect(mockPeerConnection.signalingState).toBe('stable');
    expect(onNegotiationError).not.toHaveBeenCalled();
  });

  it('impolite peer ignores a colliding offer', async () => {
    const { mockPeerConnection, sendPayload, negotiation } = startNegotiation(false);
    await mockPeerConnection.onnegotiationneeded?.(new Event('negotiationneeded'));
    sendPayload.mockClear();
    await negotiation.handleRemotePayload(REMOTE_OFFER);
    expect(mockPeerConnection.setRemoteDescription).not.toHaveBeenCalled();
    expect(sendPayload).not.toHaveBeenCalled();
    expect(mockPeerConnection.signalingState).toBe('have-local-offer');
  });

  it('polite peer accepts a colliding offer and answers it', async () => {
    const { mockPeerConnection, sendPayload, negotiation } = startNegotiation(true);
    await mockPeerConnection.onnegotiationneeded?.(new Event('negotiationneeded'));
    sendPayload.mockClear();
    await negotiation.handleRemotePayload(REMOTE_OFFER);
    expect(mockPeerConnection.setRemoteDescription).toHaveBeenCalledWith(REMOTE_OFFER.data);
    expect(sendPayload).toHaveBeenCalledWith({
      kind: 'answer',
      data: { type: 'answer', sdp: 'local-answer-sdp' },
    });
  });

  it('treats an offer that arrives while we are making one as a collision', async () => {
    const { mockPeerConnection, sendPayload, negotiation } = startNegotiation(false);
    let finishSettingLocalDescription: () => void = () => {};
    mockPeerConnection.setLocalDescription.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishSettingLocalDescription = resolve)),
    );
    const offerInProgress = mockPeerConnection.onnegotiationneeded?.(
      new Event('negotiationneeded'),
    );
    await negotiation.handleRemotePayload(REMOTE_OFFER);
    expect(mockPeerConnection.setRemoteDescription).not.toHaveBeenCalled();
    finishSettingLocalDescription();
    await offerInProgress;
    expect(sendPayload).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'answer' }));
  });

  it('forwards local ICE candidates and skips the end-of-candidates marker', () => {
    const { mockPeerConnection, sendPayload } = startNegotiation(false);
    mockPeerConnection.onicecandidate?.({
      candidate: {
        candidate: 'candidate:1',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'abcd',
      },
    } as RTCPeerConnectionIceEvent);
    mockPeerConnection.onicecandidate?.({ candidate: null } as RTCPeerConnectionIceEvent);
    expect(sendPayload).toHaveBeenCalledTimes(1);
    expect(sendPayload).toHaveBeenCalledWith({
      kind: 'candidate',
      data: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' },
    });
  });

  describe('sendOnlyRelayCandidates', () => {
    function startRelayOnlyNegotiation() {
      const mockPeerConnection = createMockPeerConnection();
      const sendPayload = vi.fn();
      startPerfectNegotiation({
        peerConnection: mockPeerConnection as unknown as NegotiablePeerConnection,
        isPolite: false,
        sendPayload,
        onNegotiationError: vi.fn(),
        sendOnlyRelayCandidates: true,
      });
      return { mockPeerConnection, sendPayload };
    }
    const candidateEvent = (candidate: string) =>
      ({
        candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' },
      }) as RTCPeerConnectionIceEvent;

    it('sends relay candidates but never host, srflx, prflx or unreadable ones', () => {
      const { mockPeerConnection, sendPayload } = startRelayOnlyNegotiation();
      for (const candidate of [
        'candidate:1 1 udp 1 192.168.1.5 1 typ host',
        'candidate:2 1 udp 1 203.0.113.9 1 typ srflx raddr 192.168.1.5 rport 1',
        'candidate:3 1 udp 1 203.0.113.9 1 typ prflx',
        'candidate:4',
        'candidate:5 1 udp 1 198.51.100.7 1 typ relay',
      ]) {
        mockPeerConnection.onicecandidate?.(candidateEvent(candidate));
      }
      expect(sendPayload).toHaveBeenCalledTimes(1);
      expect(sendPayload).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'candidate', data: expect.objectContaining({}) }),
      );
    });

    it('removes host and srflx candidate lines from an offer and an answer', async () => {
      const { mockPeerConnection, sendPayload } = startRelayOnlyNegotiation();
      const sdpWithCandidates = [
        'v=0',
        'a=candidate:1 1 udp 1 192.168.1.5 1 typ host',
        'a=candidate:5 1 udp 1 198.51.100.7 1 typ relay',
      ].join('\r\n');
      mockPeerConnection.setLocalDescription.mockImplementation(async () => {
        mockPeerConnection.localDescription = {
          type: 'offer',
          sdp: sdpWithCandidates,
        } as RTCSessionDescription;
      });
      await mockPeerConnection.onnegotiationneeded?.(new Event('negotiationneeded'));
      expect(sendPayload).toHaveBeenCalledWith({
        kind: 'offer',
        data: {
          type: 'offer',
          sdp: ['v=0', 'a=candidate:5 1 udp 1 198.51.100.7 1 typ relay'].join('\r\n'),
        },
      });
    });
  });

  it('adds remote ICE candidates', async () => {
    const { mockPeerConnection, negotiation } = startNegotiation(false);
    await negotiation.handleRemotePayload({
      kind: 'candidate',
      data: { candidate: 'candidate:2', sdpMid: '0', sdpMLineIndex: 0 },
      seq: 2,
    });
    expect(mockPeerConnection.addIceCandidate).toHaveBeenCalledWith({
      candidate: 'candidate:2',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
  });

  it('reports a failing candidate normally, but not after an ignored offer', async () => {
    const { mockPeerConnection, negotiation, onNegotiationError } = startNegotiation(false);
    mockPeerConnection.addIceCandidate.mockRejectedValue(new Error('bad candidate'));
    const remoteCandidate = { kind: 'candidate', data: { candidate: 'c' }, seq: 5 } as const;
    await negotiation.handleRemotePayload(remoteCandidate);
    expect(onNegotiationError).toHaveBeenCalledTimes(1);

    await mockPeerConnection.onnegotiationneeded?.(new Event('negotiationneeded'));
    await negotiation.handleRemotePayload(REMOTE_OFFER);
    await negotiation.handleRemotePayload({ ...remoteCandidate, seq: 6 });
    expect(onNegotiationError).toHaveBeenCalledTimes(1);
  });

  it('reports an answer that arrives in the wrong state instead of throwing', async () => {
    const { negotiation, onNegotiationError } = startNegotiation(false);
    await negotiation.handleRemotePayload(REMOTE_ANSWER);
    expect(onNegotiationError).toHaveBeenCalledTimes(1);
  });

  it('does nothing after it was stopped', async () => {
    const { mockPeerConnection, sendPayload, negotiation } = startNegotiation(true);
    negotiation.stop();
    await negotiation.handleRemotePayload(REMOTE_OFFER);
    expect(mockPeerConnection.setRemoteDescription).not.toHaveBeenCalled();
    expect(sendPayload).not.toHaveBeenCalled();
    expect(mockPeerConnection.onnegotiationneeded).toBeNull();
  });
});
