/**
 * AES-256-GCM encryption of signaling messages (PLAN.md section 3.1) with the `signalKey`.
 *
 * Every message gets a fresh random 12-byte IV from `crypto.getRandomValues`; an IV is never
 * reused and never derived from a counter. The ciphertext includes the 16-byte GCM tag.
 *
 * ## Additional authenticated data (AAD)
 *
 * Authenticated but not encrypted. Fixed length, 62 bytes, so no field can bleed into another:
 *
 *   offset  size  field
 *   0       21    label: ASCII "secure-call/signal/v1" (the version; a new layout = a new label)
 *   21      1     sender role: 0x00 = hello, 0x01 = sender's session ID is the smaller one,
 *                 0x02 = sender's session ID is the larger one (compared as 16 unsigned bytes)
 *   22      8     seq: the message counter, unsigned 64-bit, big-endian
 *   30      16    sender's session ID (all zero bytes in a hello)
 *   46      16    receiver's session ID, i.e. the one the sender learned from the receiver's
 *                 hello (all zero bytes in a hello)
 *
 * ## Session binding (why a recorded message can never be accepted later)
 *
 * Every time a peer connection is opened (the other person arrived), each side picks a new random
 * 16-byte session ID and sends it in an encrypted `hello` payload (seq 0). A hello's own AAD has
 * role 0x00 and zero session IDs, because neither ID is known to the receiver yet. Nothing else
 * is sent until the other side's hello has arrived. From then on every AAD carries both session
 * IDs, so a message recorded in an earlier session fails authentication: the receiver's session
 * ID is new. The counter `seq` must be exactly the next expected one, which stops replays and
 * reordering inside a session. A replayed hello can only make the call fail (the real hello then
 * has a different session ID, or later messages fail to authenticate), never be accepted as live.
 *
 * The role byte is derived from the two session IDs instead of the server's `first`/`second`
 * because the server gives the SAME role to both people when the first one leaves and someone new
 * joins. This way the two sides always have opposite roles, and a message reflected back to its
 * sender fails.
 *
 * Never log the key, IVs or plaintext.
 */

export const SIGNAL_IV_BYTES = 12;
export const SESSION_ID_BYTES = 16;
const AAD_LABEL_BYTES = new TextEncoder().encode('secure-call/signal/v1');
export const SIGNAL_AAD_BYTES = AAD_LABEL_BYTES.length + 1 + 8 + 2 * SESSION_ID_BYTES;

const ROLE_BYTE_BY_SENDER_ROLE = {
  hello: 0x00,
  'smaller-session-id': 0x01,
  'larger-session-id': 0x02,
} as const;
export type SignalSenderRole = keyof typeof ROLE_BYTE_BY_SENDER_ROLE;

export type SignalAadFields = {
  senderRole: SignalSenderRole;
  sequenceNumber: number;
  /** Zero bytes for a hello. */
  senderSessionId: Uint8Array;
  /** Zero bytes for a hello. */
  receiverSessionId: Uint8Array;
};

export function createSessionId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES));
}

/** Which role a side has, given its own and the other side's session ID. Null if they are equal. */
export function decideSenderRoles(
  ownSessionId: Uint8Array,
  otherSessionId: Uint8Array,
): { ownRole: SignalSenderRole; otherRole: SignalSenderRole } | null {
  for (let i = 0; i < SESSION_ID_BYTES; i++) {
    const ownByte = ownSessionId[i]!;
    const otherByte = otherSessionId[i]!;
    if (ownByte < otherByte) {
      return { ownRole: 'smaller-session-id', otherRole: 'larger-session-id' };
    }
    if (ownByte > otherByte) {
      return { ownRole: 'larger-session-id', otherRole: 'smaller-session-id' };
    }
  }
  return null;
}

export function buildSignalAad(aadFields: SignalAadFields): Uint8Array {
  const { senderRole, sequenceNumber, senderSessionId, receiverSessionId } = aadFields;
  if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 0) {
    throw new Error('Sequence number is invalid');
  }
  if (
    senderSessionId.length !== SESSION_ID_BYTES ||
    receiverSessionId.length !== SESSION_ID_BYTES
  ) {
    throw new Error('Session ID has the wrong length');
  }
  const aadBytes = new Uint8Array(SIGNAL_AAD_BYTES);
  aadBytes.set(AAD_LABEL_BYTES, 0);
  aadBytes[AAD_LABEL_BYTES.length] = ROLE_BYTE_BY_SENDER_ROLE[senderRole];
  new DataView(aadBytes.buffer).setBigUint64(AAD_LABEL_BYTES.length + 1, BigInt(sequenceNumber));
  aadBytes.set(senderSessionId, AAD_LABEL_BYTES.length + 9);
  aadBytes.set(receiverSessionId, AAD_LABEL_BYTES.length + 9 + SESSION_ID_BYTES);
  return aadBytes;
}

/** AAD of a hello: role 0x00 and all-zero session IDs. */
export function buildHelloAad(sequenceNumber: number): Uint8Array {
  const zeroSessionId = new Uint8Array(SESSION_ID_BYTES);
  return buildSignalAad({
    senderRole: 'hello',
    sequenceNumber,
    senderSessionId: zeroSessionId,
    receiverSessionId: zeroSessionId,
  });
}

/** Encrypts with a new random IV. Returns the ciphertext (with tag) and the IV. */
export async function encryptSignalBytes(encryptionOptions: {
  signalKey: CryptoKey;
  plaintextBytes: Uint8Array;
  additionalData: Uint8Array;
}): Promise<{ ciphertextBytes: Uint8Array; ivBytes: Uint8Array }> {
  const ivBytes = crypto.getRandomValues(new Uint8Array(SIGNAL_IV_BYTES));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes as BufferSource,
      additionalData: encryptionOptions.additionalData as BufferSource,
      tagLength: 128,
    },
    encryptionOptions.signalKey,
    encryptionOptions.plaintextBytes as BufferSource,
  );
  return { ciphertextBytes: new Uint8Array(ciphertextBuffer), ivBytes };
}

/** Returns the plaintext, or null if the IV is wrong, or the ciphertext or AAD do not match. */
export async function decryptSignalBytes(decryptionOptions: {
  signalKey: CryptoKey;
  ciphertextBytes: Uint8Array;
  ivBytes: Uint8Array;
  additionalData: Uint8Array;
}): Promise<Uint8Array | null> {
  if (decryptionOptions.ivBytes.length !== SIGNAL_IV_BYTES) return null;
  try {
    const plaintextBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: decryptionOptions.ivBytes as BufferSource,
        additionalData: decryptionOptions.additionalData as BufferSource,
        tagLength: 128,
      },
      decryptionOptions.signalKey,
      decryptionOptions.ciphertextBytes as BufferSource,
    );
    return new Uint8Array(plaintextBuffer);
  } catch {
    return null;
  }
}
