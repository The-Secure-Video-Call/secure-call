import { z } from 'zod';

/** Largest SDP or candidate text we accept; the whole payload is capped lower by the envelope. */
export const SIGNAL_PAYLOAD_TEXT_MAX_LENGTH = 40000;

const sequenceNumberSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sessionDescriptionTextSchema = z.string().min(1).max(SIGNAL_PAYLOAD_TEXT_MAX_LENGTH);

/**
 * What travels inside `signal.payload` (PLAN.md section 6), after base64 decoding. The server
 * never sees this; only the two browsers do. `seq` is a counter that blocks replayed messages.
 */
export const signalPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('offer'),
    data: z.strictObject({ type: z.literal('offer'), sdp: sessionDescriptionTextSchema }),
    seq: sequenceNumberSchema,
  }),
  z.strictObject({
    kind: z.literal('answer'),
    data: z.strictObject({ type: z.literal('answer'), sdp: sessionDescriptionTextSchema }),
    seq: sequenceNumberSchema,
  }),
  z.strictObject({
    kind: z.literal('candidate'),
    data: z.strictObject({
      candidate: z.string().max(2000),
      sdpMid: z.string().max(256).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(65535).nullable().optional(),
      usernameFragment: z.string().max(256).nullable().optional(),
    }),
    seq: sequenceNumberSchema,
  }),
  z.strictObject({
    kind: z.literal('bye'),
    data: z.null(),
    seq: sequenceNumberSchema,
  }),
]);

export type SignalPayload = z.infer<typeof signalPayloadSchema>;
/** A payload before a sequence number is assigned. */
export type SignalPayloadWithoutSequenceNumber = SignalPayload extends infer EachPayload
  ? EachPayload extends SignalPayload
    ? Omit<EachPayload, 'seq'>
    : never
  : never;
