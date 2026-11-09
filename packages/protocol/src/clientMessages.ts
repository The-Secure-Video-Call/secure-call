import { z } from 'zod';
import { protocolVersionSchema } from '@protocol/protocolVersion';
import { signalMessageSchema } from '@protocol/signalMessage';

export const joinMessageSchema = z.strictObject({
  v: protocolVersionSchema,
  type: z.literal('join'),
  // Derived in the browser; the room secret itself never leaves it.
  roomId: z.string().regex(/^[A-Za-z0-9_-]{22,43}$/),
});
export const leaveMessageSchema = z.strictObject({
  v: protocolVersionSchema,
  type: z.literal('leave'),
});
export const pingMessageSchema = z.strictObject({
  v: protocolVersionSchema,
  type: z.literal('ping'),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  joinMessageSchema,
  signalMessageSchema,
  leaveMessageSchema,
  pingMessageSchema,
]);

export type JoinMessage = z.infer<typeof joinMessageSchema>;
export type LeaveMessage = z.infer<typeof leaveMessageSchema>;
export type PingMessage = z.infer<typeof pingMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
