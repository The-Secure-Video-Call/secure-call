import { z } from 'zod';
import { protocolVersionSchema } from '@protocol/protocolVersion';
import { signalMessageSchema } from '@protocol/signalMessage';

export const SERVER_ERROR_CODES = [
  'room-full',
  'rate-limited',
  'bad-message',
  'unsupported-type',
] as const;

export const joinedMessageSchema = z.strictObject({
  v: protocolVersionSchema,
  type: z.literal('joined'),
  role: z.enum(['first', 'second']),
});
export const peerJoinedMessageSchema = z.strictObject({
  v: protocolVersionSchema,
  type: z.literal('peer-joined'),
});
export const peerLeftMessageSchema = z.strictObject({
  v: protocolVersionSchema,
  type: z.literal('peer-left'),
});
export const errorMessageSchema = z.strictObject({
  v: protocolVersionSchema,
  type: z.literal('error'),
  code: z.enum(SERVER_ERROR_CODES),
});
export const pongMessageSchema = z.strictObject({
  v: protocolVersionSchema,
  type: z.literal('pong'),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  joinedMessageSchema,
  peerJoinedMessageSchema,
  peerLeftMessageSchema,
  signalMessageSchema,
  errorMessageSchema,
  pongMessageSchema,
]);

export type JoinedMessage = z.infer<typeof joinedMessageSchema>;
export type PeerJoinedMessage = z.infer<typeof peerJoinedMessageSchema>;
export type PeerLeftMessage = z.infer<typeof peerLeftMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type PongMessage = z.infer<typeof pongMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

export type ParsedServerMessage = { ok: true; message: ServerMessage } | { ok: false };

/** Parses raw WebSocket text from the server. Never throws; invalid input yields `{ ok: false }`. */
export function parseServerMessage(rawText: unknown): ParsedServerMessage {
  if (typeof rawText !== 'string') return { ok: false };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    return { ok: false };
  }
  const parseResult = serverMessageSchema.safeParse(parsedJson);
  return parseResult.success ? { ok: true, message: parseResult.data } : { ok: false };
}
