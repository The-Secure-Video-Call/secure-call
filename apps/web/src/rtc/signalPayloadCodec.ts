import { fromBase64, toBase64 } from '@/crypto/base64';
import {
  buildHelloAad,
  buildSignalAad,
  decryptSignalBytes,
  encryptSignalBytes,
  SIGNAL_IV_BYTES,
  type SignalSenderRole,
} from '@/crypto/signalEncryption';
import {
  SIGNAL_PAYLOAD_MAX_LENGTH,
  signalPayloadSchema,
  type SignalPayload,
} from '@protocol/index';

/**
 * Which session IDs and role go into the AAD. `null` means a hello (role 0x00, zero IDs).
 * See the byte layout in `@/crypto/signalEncryption`.
 */
export type SignalAadContext = {
  senderRole: SignalSenderRole;
  senderSessionId: Uint8Array;
  receiverSessionId: Uint8Array;
} | null;

function buildAadForPayload(aadContext: SignalAadContext, sequenceNumber: number): Uint8Array {
  return aadContext === null
    ? buildHelloAad(sequenceNumber)
    : buildSignalAad({ ...aadContext, sequenceNumber });
}

/**
 * Turns `{kind, data, seq}` into the two texts of a `signal` message: `payload` (base64 of the
 * AES-GCM ciphertext) and `iv` (base64 of the new random 12-byte IV). Throws if the payload is
 * invalid or the result would not fit `SIGNAL_PAYLOAD_MAX_LENGTH`; nothing is sent in that case.
 */
export async function encryptSignalPayload(encryptionOptions: {
  signalKey: CryptoKey;
  signalPayload: SignalPayload;
  aadContext: SignalAadContext;
}): Promise<{ payload: string; iv: string }> {
  const { signalKey, signalPayload, aadContext } = encryptionOptions;
  const plaintextBytes = new TextEncoder().encode(
    JSON.stringify(signalPayloadSchema.parse(signalPayload)),
  );
  // Base64 length of plaintext + 16-byte tag; check before spending effort on encryption.
  if (Math.ceil((plaintextBytes.length + 16) / 3) * 4 > SIGNAL_PAYLOAD_MAX_LENGTH) {
    throw new Error('Signal payload is too large to send');
  }
  const { ciphertextBytes, ivBytes } = await encryptSignalBytes({
    signalKey,
    plaintextBytes,
    additionalData: buildAadForPayload(aadContext, signalPayload.seq),
  });
  return { payload: toBase64(ciphertextBytes), iv: toBase64(ivBytes) };
}

/**
 * Decrypts and validates a received message. Returns null for anything wrong: a missing or
 * malformed `iv`, bad base64, failed authentication (tampering, wrong key, wrong role, `seq` or
 * session ID), invalid JSON or a payload that does not match the schema, or a `seq` inside it
 * that is not `expectedSequenceNumber`. The caller must end the call on null.
 */
export async function decryptSignalPayload(decryptionOptions: {
  signalKey: CryptoKey;
  payload: string;
  iv: string | null;
  expectedSequenceNumber: number;
  aadContext: SignalAadContext;
}): Promise<SignalPayload | null> {
  const { signalKey, payload, iv, expectedSequenceNumber, aadContext } = decryptionOptions;
  if (iv === null) return null;
  const ivBytes = fromBase64(iv);
  const ciphertextBytes = fromBase64(payload);
  if (ivBytes === null || ivBytes.length !== SIGNAL_IV_BYTES || ciphertextBytes === null) {
    return null;
  }
  const plaintextBytes = await decryptSignalBytes({
    signalKey,
    ciphertextBytes,
    ivBytes,
    additionalData: buildAadForPayload(aadContext, expectedSequenceNumber),
  });
  if (plaintextBytes === null) return null;
  try {
    const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(plaintextBytes);
    const parseResult = signalPayloadSchema.safeParse(JSON.parse(jsonText));
    if (!parseResult.success || parseResult.data.seq !== expectedSequenceNumber) return null;
    return parseResult.data;
  } catch {
    return null;
  }
}
