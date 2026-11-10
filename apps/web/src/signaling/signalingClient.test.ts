import { describe, expect, it, vi } from 'vitest';
import {
  CLOSE_CODE_NORMAL,
  CLOSE_CODE_POLICY_VIOLATION,
  connectToSignalingServer,
  type SignalingWebSocket,
} from '@/signaling/signalingClient';

const ROOM_ID = 'AAAAAAAAAAAAAAAAAAAAAA';

/** Like browsers: only 1000 or 3000-4999 (or no code at all) may be used to close. */
function closeLikeABrowser(closeCode?: number): void {
  if (closeCode === undefined) return;
  if (closeCode !== 1000 && !(closeCode >= 3000 && closeCode <= 4999)) {
    throw new Error(
      `InvalidAccessError: The close code must be either 1000, or between 3000 and 4999. ${closeCode} is neither.`,
    );
  }
}

function createFakeWebSocket() {
  const sentTexts: string[] = [];
  const fakeWebSocket: SignalingWebSocket = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (textToSend) => sentTexts.push(textToSend),
    close: vi.fn(closeLikeABrowser),
  };
  function receive(messageData: unknown): void {
    fakeWebSocket.onmessage?.({ data: messageData } as MessageEvent);
  }
  return { fakeWebSocket, sentTexts, receive };
}

function connect() {
  const { fakeWebSocket, sentTexts, receive } = createFakeWebSocket();
  const events = {
    onJoined: vi.fn(),
    onPeerJoined: vi.fn(),
    onPeerLeft: vi.fn(),
    onSignal: vi.fn(),
    onServerError: vi.fn(),
    onClosed: vi.fn(),
  };
  const createWebSocket = vi.fn(() => fakeWebSocket);
  const client = connectToSignalingServer({
    signalingUrl: 'ws://localhost:8000/ws/signal/',
    roomId: ROOM_ID,
    events,
    createWebSocket,
  });
  return { client, fakeWebSocket, sentTexts, receive, events, createWebSocket };
}

describe('connectToSignalingServer', () => {
  it('sends join with only the room ID once the socket opens', () => {
    const { fakeWebSocket, sentTexts, createWebSocket } = connect();
    expect(createWebSocket).toHaveBeenCalledWith('ws://localhost:8000/ws/signal/');
    fakeWebSocket.onopen?.(new Event('open'));
    expect(sentTexts.map((sentText) => JSON.parse(sentText))).toEqual([
      { v: 1, type: 'join', roomId: ROOM_ID },
    ]);
  });

  it('reports joined, peer-joined, peer-left and relayed signals', () => {
    const { receive, events } = connect();
    receive('{"v":1,"type":"joined","role":"second"}');
    receive('{"v":1,"type":"peer-joined"}');
    receive('{"v":1,"type":"signal","payload":"QUJD","iv":"AAAAAAAAAAAAAAAA"}');
    receive('{"v":1,"type":"peer-left"}');
    expect(events.onJoined).toHaveBeenCalledWith('second', undefined);
    expect(events.onPeerJoined).toHaveBeenCalledTimes(1);
    expect(events.onSignal).toHaveBeenCalledWith('QUJD', 'AAAAAAAAAAAAAAAA');
    expect(events.onPeerLeft).toHaveBeenCalledTimes(1);
  });

  it('passes the TURN credentials of joined on, and none when joined has no turn', () => {
    const turn = {
      urls: ['turn:turn.example.com:3478?transport=udp'],
      username: '1700003600:AAECAwQFBgcICQoLDA0ODw',
      credential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    };
    const withTurn = connect();
    withTurn.receive(JSON.stringify({ v: 1, type: 'joined', role: 'first', turn }));
    expect(withTurn.events.onJoined).toHaveBeenCalledWith('first', turn);
    const withoutTurn = connect();
    withoutTurn.receive('{"v":1,"type":"joined","role":"first"}');
    expect(withoutTurn.events.onJoined).toHaveBeenCalledWith('first', undefined);
  });

  it.each([
    ['an http: URL', { urls: ['http://turn.example.com'], username: 'user', credential: 'secret' }],
    [
      'an extra field',
      { urls: ['turn:turn.example.com:3478'], username: 'user', credential: 'secret', extra: 1 },
    ],
    ['no URLs', { urls: [], username: 'user', credential: 'secret' }],
  ])('rejects joined with a turn that has %s and closes with 4008', (_description, badTurn) => {
    const { receive, events, fakeWebSocket } = connect();
    receive(JSON.stringify({ v: 1, type: 'joined', role: 'first', turn: badTurn }));
    expect(events.onJoined).not.toHaveBeenCalled();
    expect(fakeWebSocket.close).toHaveBeenCalledWith(4008);
    expect(events.onClosed).toHaveBeenCalledWith('invalid-server-message');
  });

  it('drops a server signal without iv and closes the connection', () => {
    const { receive, events, fakeWebSocket } = connect();
    receive('{"v":1,"type":"joined","role":"first"}');
    receive('{"v":1,"type":"signal","payload":"QUJD"}');
    expect(events.onSignal).not.toHaveBeenCalled();
    expect(events.onClosed).toHaveBeenCalledWith('invalid-server-message');
    expect(fakeWebSocket.close).toHaveBeenCalled();
  });

  it('reports server errors such as room-full', () => {
    const { receive, events } = connect();
    receive('{"v":1,"type":"error","code":"room-full"}');
    expect(events.onServerError).toHaveBeenCalledWith('room-full');
  });

  it.each([
    ['not JSON', 'hello'],
    ['an unknown type', '{"v":1,"type":"surprise"}'],
    ['a wrong version', '{"v":2,"type":"peer-left"}'],
    ['an extra field', '{"v":1,"type":"peer-left","extra":true}'],
    ['a bad payload', '{"v":1,"type":"signal","payload":"not base64!"}'],
    ['a binary frame', new ArrayBuffer(4)],
  ])('drops %s and closes the connection', (_description, invalidMessage) => {
    const { receive, events, fakeWebSocket } = connect();
    receive('{"v":1,"type":"joined","role":"first"}');
    receive(invalidMessage);
    expect(fakeWebSocket.close).toHaveBeenCalledWith(4008);
    expect(fakeWebSocket.close).toHaveBeenCalledTimes(1);
    expect(events.onClosed).toHaveBeenCalledWith('invalid-server-message');
    expect(events.onPeerLeft).not.toHaveBeenCalled();
    expect(events.onSignal).not.toHaveBeenCalled();
  });

  it('ignores messages that arrive after it closed', () => {
    const { receive, events } = connect();
    receive('{"v":1,"type":"joined","role":"first"}');
    receive('garbage');
    receive('{"v":1,"type":"peer-joined"}');
    expect(events.onPeerJoined).not.toHaveBeenCalled();
    expect(events.onClosed).toHaveBeenCalledTimes(1);
  });

  it('closes when the server sends a peer event before joined', () => {
    const { receive, events } = connect();
    receive('{"v":1,"type":"peer-joined"}');
    expect(events.onPeerJoined).not.toHaveBeenCalled();
    expect(events.onClosed).toHaveBeenCalledWith('invalid-server-message');
  });

  it('closes when joined arrives twice', () => {
    const { receive, events } = connect();
    receive('{"v":1,"type":"joined","role":"first"}');
    receive('{"v":1,"type":"joined","role":"second"}');
    expect(events.onClosed).toHaveBeenCalledWith('invalid-server-message');
  });

  it('wraps a payload and its iv in a signal message', () => {
    const { client, receive, sentTexts } = connect();
    receive('{"v":1,"type":"joined","role":"first"}');
    client.sendSignal('QUJD', 'AAAAAAAAAAAAAAAA');
    expect(JSON.parse(sentTexts[0]!)).toEqual({
      v: 1,
      type: 'signal',
      payload: 'QUJD',
      iv: 'AAAAAAAAAAAAAAAA',
    });
  });

  it('refuses to send an invalid or too-early signal', () => {
    const { client, receive } = connect();
    expect(() => client.sendSignal('QUJD', 'AAAAAAAAAAAAAAAA')).toThrow();
    receive('{"v":1,"type":"joined","role":"first"}');
    expect(() => client.sendSignal('not base64!', 'AAAAAAAAAAAAAAAA')).toThrow();
    expect(() => client.sendSignal('A'.repeat(64513), 'AAAAAAAAAAAAAAAA')).toThrow();
    expect(() => client.sendSignal('QUJD', 'short')).toThrow();
  });

  it('sends leave and closes when asked', () => {
    const { client, receive, sentTexts, events, fakeWebSocket } = connect();
    receive('{"v":1,"type":"joined","role":"first"}');
    client.leaveAndClose();
    expect(JSON.parse(sentTexts[0]!)).toEqual({ v: 1, type: 'leave' });
    expect(fakeWebSocket.close).toHaveBeenCalled();
    expect(events.onClosed).toHaveBeenCalledWith('closed-by-us');
  });

  it('closes instead of hanging when the room ID is invalid', () => {
    const { fakeWebSocket } = createFakeWebSocket();
    const onClosed = vi.fn();
    connectToSignalingServer({
      signalingUrl: 'ws://localhost:8000/ws/signal/',
      roomId: 'not a valid room id',
      events: {
        onJoined: vi.fn(),
        onPeerJoined: vi.fn(),
        onPeerLeft: vi.fn(),
        onSignal: vi.fn(),
        onServerError: vi.fn(),
        onClosed,
      },
      createWebSocket: () => fakeWebSocket,
    });
    expect(() => fakeWebSocket.onopen?.(new Event('open'))).not.toThrow();
    expect(fakeWebSocket.close).toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('only uses close codes that browsers allow', () => {
    expect(CLOSE_CODE_POLICY_VIOLATION).toBe(4008);
    for (const closeCode of [CLOSE_CODE_NORMAL, CLOSE_CODE_POLICY_VIOLATION]) {
      expect(closeCode === 1000 || (closeCode >= 3000 && closeCode <= 4999)).toBe(true);
    }
  });

  it('has a test double that throws for close codes browsers refuse', () => {
    const { fakeWebSocket } = createFakeWebSocket();
    expect(() => fakeWebSocket.close(1008)).toThrow(/1008 is neither/);
    expect(() => fakeWebSocket.close(2999)).toThrow();
    expect(() => fakeWebSocket.close(5000)).toThrow();
    expect(() => fakeWebSocket.close(1000)).not.toThrow();
    expect(() => fakeWebSocket.close(4008)).not.toThrow();
  });

  it('still reports closed exactly once if closing the socket throws', () => {
    const { receive, events, fakeWebSocket } = connect();
    fakeWebSocket.close = vi.fn(() => {
      throw new Error('close failed');
    });
    receive('{"v":1,"type":"joined","role":"first"}');
    expect(() => receive('garbage')).toThrow('close failed');
    expect(events.onClosed).toHaveBeenCalledTimes(1);
    expect(events.onClosed).toHaveBeenCalledWith('invalid-server-message');
  });

  it('reports a lost connection', () => {
    const { fakeWebSocket, events } = connect();
    fakeWebSocket.onclose?.(new Event('close') as CloseEvent);
    expect(events.onClosed).toHaveBeenCalledWith('connection-lost');
  });
});
