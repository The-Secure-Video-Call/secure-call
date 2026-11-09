import {
  SIGNAL_PAYLOAD_MAX_LENGTH,
  signalPayloadSchema,
  type SignalPayload,
  type SignalPayloadWithoutSequenceNumber,
} from '@protocol/index';

/** Turns `{kind, data, seq}` into the base64 text carried in `signal.payload` (not encrypted in M1). */
export function encodeSignalPayload(signalPayload: SignalPayload): string {
  const jsonBytes = new TextEncoder().encode(
    JSON.stringify(signalPayloadSchema.parse(signalPayload)),
  );
  let binaryString = '';
  for (const byteValue of jsonBytes) binaryString += String.fromCharCode(byteValue);
  const base64Text = btoa(binaryString);
  if (base64Text.length > SIGNAL_PAYLOAD_MAX_LENGTH) {
    throw new Error('Signal payload is too large to send');
  }
  return base64Text;
}

/** Reads a received payload. Returns null for anything that is not a valid `{kind, data, seq}`. */
export function decodeSignalPayload(base64Text: string): SignalPayload | null {
  try {
    const binaryString = atob(base64Text);
    const jsonBytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) jsonBytes[i] = binaryString.charCodeAt(i);
    const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes);
    const parseResult = signalPayloadSchema.safeParse(JSON.parse(jsonText));
    return parseResult.success ? parseResult.data : null;
  } catch {
    return null;
  }
}

/**
 * Counts our outgoing messages and rejects incoming ones that are not newer than the last
 * accepted one, so a replayed or reordered payload is dropped. Call `reset` when the peer changes.
 */
export function createSequenceNumberTracker() {
  let nextOutgoingSequenceNumber = 0;
  let lastAcceptedIncomingSequenceNumber = -1;
  return {
    addSequenceNumber(
      payloadWithoutSequenceNumber: SignalPayloadWithoutSequenceNumber,
    ): SignalPayload {
      const signalPayload = {
        ...payloadWithoutSequenceNumber,
        seq: nextOutgoingSequenceNumber,
      } as SignalPayload;
      nextOutgoingSequenceNumber += 1;
      return signalPayload;
    },
    acceptIncoming(incomingSequenceNumber: number): boolean {
      if (incomingSequenceNumber <= lastAcceptedIncomingSequenceNumber) return false;
      lastAcceptedIncomingSequenceNumber = incomingSequenceNumber;
      return true;
    },
    reset(): void {
      nextOutgoingSequenceNumber = 0;
      lastAcceptedIncomingSequenceNumber = -1;
    },
  };
}
