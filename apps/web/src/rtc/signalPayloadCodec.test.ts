import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from '@/crypto/base64';
import { buildSignalAad, encryptSignalBytes } from '@/crypto/signalEncryption';
import { deriveSignalKey } from '@/crypto/signalKey';
import {
  decryptSignalPayload,
  encryptSignalPayload,
  type SignalAadContext,
} from '@/rtc/signalPayloadCodec';
import { SIGNAL_PAYLOAD_MAX_LENGTH, type SignalPayload } from '@protocol/index';

const firstSessionId = new Uint8Array(16).fill(1);
const secondSessionId = new Uint8Array(16).fill(2);
const aadContext: SignalAadContext = {
  senderRole: 'smaller-session-id',
  senderSessionId: firstSessionId,
  receiverSessionId: secondSessionId,
};
const offerPayload: SignalPayload = {
  kind: 'offer',
  data: { type: 'offer', sdp: 'v=0\r\nsecret-sdp-text' },
  seq: 3,
};

async function createKey(secretByte: number) {
  return deriveSignalKey(new Uint8Array(32).fill(secretByte));
}

async function encryptOffer(signalPayload: SignalPayload = offerPayload) {
  const signalKey = await createKey(1);
  const encrypted = await encryptSignalPayload({ signalKey, signalPayload, aadContext });
  return { signalKey, ...encrypted };
}

function decryptWith(
  signalKey: CryptoKey,
  encrypted: { payload: string; iv: string | null },
  overrides: Partial<{ expectedSequenceNumber: number; aadContext: SignalAadContext }> = {},
) {
  return decryptSignalPayload({
    signalKey,
    payload: encrypted.payload,
    iv: encrypted.iv,
    expectedSequenceNumber: 3,
    aadContext,
    ...overrides,
  });
}

describe('encrypted signal payload codec', () => {
  it('round-trips every kind, including hello and non-ASCII text', async () => {
    const signalKey = await createKey(1);
    const payloads: SignalPayload[] = [
      offerPayload,
      { kind: 'answer', data: { type: 'answer', sdp: 'é✓' }, seq: 3 },
      {
        kind: 'candidate',
        data: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
        seq: 3,
      },
      { kind: 'bye', data: null, seq: 3 },
    ];
    for (const signalPayload of payloads) {
      const encrypted = await encryptSignalPayload({ signalKey, signalPayload, aadContext });
      expect(await decryptWith(signalKey, encrypted)).toEqual(signalPayload);
    }
    const helloPayload: SignalPayload = {
      kind: 'hello',
      data: { sessionId: 'AAAAAAAAAAAAAAAAAAAAAA' },
      seq: 0,
    };
    const encryptedHello = await encryptSignalPayload({
      signalKey,
      signalPayload: helloPayload,
      aadContext: null,
    });
    expect(
      await decryptWith(signalKey, encryptedHello, { expectedSequenceNumber: 0, aadContext: null }),
    ).toEqual(helloPayload);
  });

  it('sends an iv of exactly 16 base64 characters and no plaintext', async () => {
    const { payload, iv } = await encryptOffer();
    expect(iv).toMatch(/^[A-Za-z0-9+/]{16}$/);
    expect(atob(payload)).not.toContain('secret-sdp-text');
  });

  it('two encryptions of the same message differ in iv and ciphertext', async () => {
    const first = await encryptOffer();
    const second = await encryptOffer();
    expect(first.iv).not.toBe(second.iv);
    expect(first.payload).not.toBe(second.payload);
  });

  it('rejects a changed byte in the ciphertext, the tag or the iv', async () => {
    const { signalKey, payload, iv } = await encryptOffer();
    const ciphertextBytes = fromBase64(payload)!;
    for (const changedIndex of [0, ciphertextBytes.length - 1]) {
      const tamperedBytes = ciphertextBytes.slice();
      tamperedBytes[changedIndex] = tamperedBytes[changedIndex]! ^ 1;
      expect(await decryptWith(signalKey, { payload: toBase64(tamperedBytes), iv })).toBeNull();
    }
    const tamperedIvBytes = fromBase64(iv)!;
    tamperedIvBytes[0] = tamperedIvBytes[0]! ^ 1;
    expect(await decryptWith(signalKey, { payload, iv: toBase64(tamperedIvBytes) })).toBeNull();
  });

  it('rejects a wrong role, seq or session ID', async () => {
    const { signalKey, payload, iv } = await encryptOffer();
    const encrypted = { payload, iv };
    expect(await decryptWith(signalKey, encrypted)).not.toBeNull();
    expect(await decryptWith(signalKey, encrypted, { expectedSequenceNumber: 4 })).toBeNull();
    expect(await decryptWith(signalKey, encrypted, { expectedSequenceNumber: 2 })).toBeNull();
    expect(
      await decryptWith(signalKey, encrypted, {
        aadContext: { ...aadContext!, senderRole: 'larger-session-id' },
      }),
    ).toBeNull();
    expect(
      await decryptWith(signalKey, encrypted, {
        aadContext: { ...aadContext!, receiverSessionId: new Uint8Array(16).fill(7) },
      }),
    ).toBeNull();
    expect(
      await decryptWith(signalKey, encrypted, {
        aadContext: { ...aadContext!, senderSessionId: new Uint8Array(16).fill(7) },
      }),
    ).toBeNull();
    expect(await decryptWith(signalKey, encrypted, { aadContext: null })).toBeNull();
  });

  it('rejects a message from an earlier session (the receiver has a new session ID)', async () => {
    const { signalKey, payload, iv } = await encryptOffer();
    expect(
      await decryptWith(
        signalKey,
        { payload, iv },
        { aadContext: { ...aadContext!, receiverSessionId: new Uint8Array(16).fill(8) } },
      ),
    ).toBeNull();
  });

  it('rejects a message encrypted with a different room key', async () => {
    const { payload, iv } = await encryptOffer();
    expect(await decryptWith(await createKey(2), { payload, iv })).toBeNull();
  });

  it('rejects a missing iv or an iv of the wrong length or form', async () => {
    const { signalKey, payload } = await encryptOffer();
    const badIvs = [
      null,
      '',
      'AAAAAAAAAAAAAAA=', // 15 chars
      toBase64(new Uint8Array(16)), // 16 bytes
      toBase64(new Uint8Array(8)),
      '!!!!!!!!!!!!!!!!',
    ];
    for (const badIv of badIvs) {
      expect(await decryptWith(signalKey, { payload, iv: badIv })).toBeNull();
    }
  });

  it('rejects non-base64 ciphertext, decrypted text that is not valid, and a wrong seq inside', async () => {
    const { signalKey, iv } = await encryptOffer();
    expect(await decryptWith(signalKey, { payload: '***', iv })).toBeNull();

    // Authentic ciphertexts whose content is not a valid payload.
    for (const plaintextBytes of [
      new TextEncoder().encode('not json'),
      Uint8Array.of(0xff, 0xfe),
      new TextEncoder().encode(JSON.stringify({ kind: 'nope', data: null, seq: 3 })),
      new TextEncoder().encode(JSON.stringify({ kind: 'bye', data: null, seq: 3, extra: 1 })),
      new TextEncoder().encode(JSON.stringify({ kind: 'bye', data: null, seq: 9 })),
    ]) {
      const encrypted = await encryptSignalBytes({
        signalKey,
        plaintextBytes,
        additionalData: buildSignalAad({
          ...aadContext!,
          sequenceNumber: 3,
        }),
      });
      expect(
        await decryptWith(signalKey, {
          payload: toBase64(encrypted.ciphertextBytes),
          iv: toBase64(encrypted.ivBytes),
        }),
      ).toBeNull();
    }
  });

  it('refuses to encrypt a payload that would be too large to send', async () => {
    const signalKey = await createKey(1);
    const largestAsciiOffer: SignalPayload = {
      kind: 'offer',
      data: { type: 'offer', sdp: 'a'.repeat(40000) },
      seq: 0,
    };
    const encrypted = await encryptSignalPayload({
      signalKey,
      signalPayload: largestAsciiOffer,
      aadContext,
    });
    expect(encrypted.payload.length).toBeLessThanOrEqual(SIGNAL_PAYLOAD_MAX_LENGTH);

    // Within the schema's text limit, but 3 bytes per character makes the message too big.
    const multiByteOffer: SignalPayload = {
      kind: 'offer',
      data: { type: 'offer', sdp: '€'.repeat(40000) },
      seq: 0,
    };
    await expect(
      encryptSignalPayload({ signalKey, signalPayload: multiByteOffer, aadContext }),
    ).rejects.toThrow('too large');

    // Over the schema's text limit.
    const overLimitOffer = {
      kind: 'offer',
      data: { type: 'offer', sdp: 'a'.repeat(40001) },
      seq: 0,
    } as SignalPayload;
    await expect(
      encryptSignalPayload({ signalKey, signalPayload: overLimitOffer, aadContext }),
    ).rejects.toThrow();
  });
});
