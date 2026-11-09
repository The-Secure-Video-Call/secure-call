import {
  clientMessageSchema,
  parseServerMessage,
  type ClientMessage,
  type ServerErrorCode,
} from '@protocol/index';

const CLOSE_CODE_NORMAL = 1000;
/** RFC 6455 "policy violation": used when the server sends something we don't accept. */
export const CLOSE_CODE_POLICY_VIOLATION = 1008;
const WEB_SOCKET_OPEN = 1;

/** The small part of WebSocket the client uses; tests pass a fake. */
export type SignalingWebSocket = {
  readyState: number;
  onopen: ((openEvent: Event) => void) | null;
  onmessage: ((messageEvent: MessageEvent) => void) | null;
  onclose: ((closeEvent: CloseEvent) => void) | null;
  onerror: ((errorEvent: Event) => void) | null;
  send(textToSend: string): void;
  close(closeCode?: number): void;
};

export type SignalingClientClosedReason =
  'closed-by-us' | 'invalid-server-message' | 'connection-lost';

export type SignalingClientEvents = {
  onJoined(role: 'first' | 'second'): void;
  onPeerJoined(): void;
  onPeerLeft(): void;
  /** `payload` is the opaque base64 ciphertext; `iv` is always present (the schema requires it); the type allows null only so the codec's own missing-iv check stays a second line of defence. */
  onSignal(payload: string, iv: string | null): void;
  onServerError(errorCode: ServerErrorCode): void;
  onClosed(closedReason: SignalingClientClosedReason): void;
};

export type SignalingClient = {
  sendSignal(payload: string, iv: string): void;
  leaveAndClose(): void;
};

/**
 * Connects to the signaling server and joins the room. Every incoming message is validated with
 * the zod schemas; an invalid message (or a binary frame, or anything before `joined`) is
 * dropped and the connection is closed. Only the derived `roomId` is ever sent.
 */
export function connectToSignalingServer(connectionOptions: {
  signalingUrl: string;
  roomId: string;
  events: SignalingClientEvents;
  createWebSocket?: (signalingUrl: string) => SignalingWebSocket;
}): SignalingClient {
  const { signalingUrl, roomId, events } = connectionOptions;
  const createWebSocket =
    connectionOptions.createWebSocket ?? ((url: string) => new WebSocket(url));
  const webSocket = createWebSocket(signalingUrl);
  let hasJoined = false;
  let isClosed = false;

  function sendClientMessage(clientMessage: ClientMessage): void {
    // Validate our own output too, so a bug can't put a malformed message on the wire.
    webSocket.send(JSON.stringify(clientMessageSchema.parse(clientMessage)));
  }

  function closeWith(closedReason: SignalingClientClosedReason, closeCode?: number): void {
    if (isClosed) return;
    isClosed = true;
    webSocket.onopen = null;
    webSocket.onmessage = null;
    webSocket.onclose = null;
    webSocket.onerror = null;
    try {
      webSocket.close(closeCode);
    } catch {
      // Already closed.
    }
    events.onClosed(closedReason);
  }

  webSocket.onopen = () => {
    try {
      sendClientMessage({ v: 1, type: 'join', roomId });
    } catch {
      // Invalid room ID: never leave a half-open socket behind.
      closeWith('invalid-server-message', CLOSE_CODE_POLICY_VIOLATION);
    }
  };
  webSocket.onclose = () => closeWith('connection-lost');
  webSocket.onerror = () => closeWith('connection-lost');
  webSocket.onmessage = (messageEvent) => {
    if (isClosed) return;
    const parsedServerMessage = parseServerMessage(messageEvent.data);
    if (!parsedServerMessage.ok) {
      closeWith('invalid-server-message', CLOSE_CODE_POLICY_VIOLATION);
      return;
    }
    const serverMessage = parsedServerMessage.message;
    if (serverMessage.type === 'pong') return;
    if (serverMessage.type === 'error') {
      events.onServerError(serverMessage.code);
      return;
    }
    if (serverMessage.type === 'joined') {
      if (hasJoined) {
        closeWith('invalid-server-message', CLOSE_CODE_POLICY_VIOLATION);
        return;
      }
      hasJoined = true;
      events.onJoined(serverMessage.role);
      return;
    }
    if (!hasJoined) {
      closeWith('invalid-server-message', CLOSE_CODE_POLICY_VIOLATION);
      return;
    }
    if (serverMessage.type === 'peer-joined') events.onPeerJoined();
    else if (serverMessage.type === 'peer-left') events.onPeerLeft();
    else events.onSignal(serverMessage.payload, serverMessage.iv);
  };

  return {
    sendSignal(payload, initializationVector) {
      if (isClosed || !hasJoined || webSocket.readyState !== WEB_SOCKET_OPEN) {
        throw new Error('Cannot send a signal before joining or after closing');
      }
      sendClientMessage({ v: 1, type: 'signal', payload, iv: initializationVector });
    },
    leaveAndClose() {
      if (isClosed) return;
      if (hasJoined && webSocket.readyState === WEB_SOCKET_OPEN) {
        sendClientMessage({ v: 1, type: 'leave' });
      }
      closeWith('closed-by-us', CLOSE_CODE_NORMAL);
    },
  };
}
