import { z } from 'zod';
import { protocolVersionSchema } from '@protocol/protocolVersion';

/** Limits copied from contract/schema/signal.schema.json. */
export const SIGNAL_PAYLOAD_MAX_LENGTH = 64512;

/** Opaque data for the other peer; same shape in both directions. */
export const signalMessageSchema = z.strictObject({
  v: protocolVersionSchema,
  type: z.literal('signal'),
  payload: z
    .string()
    .min(1)
    .max(SIGNAL_PAYLOAD_MAX_LENGTH)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  // Base64 of the 12-byte AES-GCM IV. Required: a signal without it is rejected.
  iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
});
export type SignalMessage = z.infer<typeof signalMessageSchema>;
