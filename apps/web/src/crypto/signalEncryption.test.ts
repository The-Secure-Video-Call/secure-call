import { describe, expect, it } from 'vitest';
import { deriveSignalKey } from '@/crypto/signalKey';
import {
  SIGNAL_AAD_BYTES,
  buildHelloAad,
  buildSignalAad,
  createSessionId,
  decideSenderRoles,
  decryptSignalBytes,
  encryptSignalBytes,
  type SignalAadFields,
} from '@/crypto/signalEncryption';

const senderSessionId = new Uint8Array(16).fill(1);
const receiverSessionId = new Uint8Array(16).fill(2);
const aadFields: SignalAadFields = {
  senderRole: 'smaller-session-id',
  sequenceNumber: 5,
  senderSessionId,
  receiverSessionId,
};
const plaintextBytes = new TextEncoder().encode('{"kind":"bye"}');

async function createKey(secretByte: number) {
  return deriveSignalKey(new Uint8Array(32).fill(secretByte));
}

async function encryptExample() {
  const signalKey = await createKey(1);
  const encrypted = await encryptSignalBytes({
    signalKey,
    plaintextBytes,
    additionalData: buildSignalAad(aadFields),
  });
  return { signalKey, ...encrypted };
}

describe('signal AAD', () => {
  it('has the documented layout', () => {
    const aadBytes = buildSignalAad({ ...aadFields, sequenceNumber: 0x0102 });
    expect(aadBytes).toHaveLength(62);
    expect(SIGNAL_AAD_BYTES).toBe(62);
    expect(new TextDecoder().decode(aadBytes.slice(0, 21))).toBe('secure-call/signal/v1');
    expect(aadBytes[21]).toBe(1);
    expect([...aadBytes.slice(22, 30)]).toEqual([0, 0, 0, 0, 0, 0, 1, 2]);
    expect(aadBytes.slice(30, 46)).toEqual(senderSessionId);
    expect(aadBytes.slice(46, 62)).toEqual(receiverSessionId);
  });

  it('a hello has role 0 and zero session IDs', () => {
    const helloAad = buildHelloAad(0);
    expect(helloAad[21]).toBe(0);
    expect(helloAad.slice(30).every((byteValue) => byteValue === 0)).toBe(true);
  });

  it('rejects invalid sequence numbers and session IDs', () => {
    expect(() => buildSignalAad({ ...aadFields, sequenceNumber: -1 })).toThrow();
    expect(() => buildSignalAad({ ...aadFields, sequenceNumber: 1.5 })).toThrow();
    expect(() => buildSignalAad({ ...aadFields, senderSessionId: new Uint8Array(15) })).toThrow();
  });

  it('gives the two sides opposite roles, and nobody a role when the IDs are equal', () => {
    expect(decideSenderRoles(senderSessionId, receiverSessionId)).toEqual({
      ownRole: 'smaller-session-id',
      otherRole: 'larger-session-id',
    });
    expect(decideSenderRoles(receiverSessionId, senderSessionId)).toEqual({
      ownRole: 'larger-session-id',
      otherRole: 'smaller-session-id',
    });
    expect(decideSenderRoles(senderSessionId, senderSessionId.slice())).toBeNull();
  });

  it('creates different 16-byte session IDs', () => {
    expect(createSessionId()).toHaveLength(16);
    expect(createSessionId()).not.toEqual(createSessionId());
  });
});

describe('signal encryption', () => {
  it('decrypts what it encrypted', async () => {
    const { signalKey, ciphertextBytes, ivBytes } = await encryptExample();
    expect(ivBytes).toHaveLength(12);
    expect(ciphertextBytes).toHaveLength(plaintextBytes.length + 16);
    const decryptedBytes = await decryptSignalBytes({
      signalKey,
      ciphertextBytes,
      ivBytes,
      additionalData: buildSignalAad(aadFields),
    });
    expect(decryptedBytes).toEqual(plaintextBytes);
  });

  it('uses a different IV and ciphertext every time', async () => {
    const signalKey = await createKey(1);
    const additionalData = buildSignalAad(aadFields);
    const first = await encryptSignalBytes({ signalKey, plaintextBytes, additionalData });
    const second = await encryptSignalBytes({ signalKey, plaintextBytes, additionalData });
    expect(first.ivBytes).not.toEqual(second.ivBytes);
    expect(first.ciphertextBytes).not.toEqual(second.ciphertextBytes);
  });

  it('rejects one changed byte anywhere in the ciphertext, the tag or the IV', async () => {
    const { signalKey, ciphertextBytes, ivBytes } = await encryptExample();
    const additionalData = buildSignalAad(aadFields);
    for (let i = 0; i < ciphertextBytes.length; i++) {
      const tamperedCiphertext = ciphertextBytes.slice();
      tamperedCiphertext[i] = tamperedCiphertext[i]! ^ 1;
      expect(
        await decryptSignalBytes({
          signalKey,
          ciphertextBytes: tamperedCiphertext,
          ivBytes,
          additionalData,
        }),
      ).toBeNull();
    }
    for (let i = 0; i < ivBytes.length; i++) {
      const tamperedIv = ivBytes.slice();
      tamperedIv[i] = tamperedIv[i]! ^ 1;
      expect(
        await decryptSignalBytes({
          signalKey,
          ciphertextBytes,
          ivBytes: tamperedIv,
          additionalData,
        }),
      ).toBeNull();
    }
  });

  it('rejects a wrong role, seq or session ID in the AAD', async () => {
    const { signalKey, ciphertextBytes, ivBytes } = await encryptExample();
    const wrongAadFieldsList: SignalAadFields[] = [
      { ...aadFields, senderRole: 'larger-session-id' },
      { ...aadFields, sequenceNumber: 6 },
      { ...aadFields, senderSessionId: new Uint8Array(16).fill(9) },
      { ...aadFields, receiverSessionId: new Uint8Array(16).fill(9) },
      { ...aadFields, senderSessionId: receiverSessionId, receiverSessionId: senderSessionId },
    ];
    for (const wrongAadFields of wrongAadFieldsList) {
      expect(
        await decryptSignalBytes({
          signalKey,
          ciphertextBytes,
          ivBytes,
          additionalData: buildSignalAad(wrongAadFields),
        }),
      ).toBeNull();
    }
    expect(
      await decryptSignalBytes({
        signalKey,
        ciphertextBytes,
        ivBytes,
        additionalData: buildHelloAad(5),
      }),
    ).toBeNull();
  });

  it('rejects a message encrypted with another room key', async () => {
    const { ciphertextBytes, ivBytes } = await encryptExample();
    expect(
      await decryptSignalBytes({
        signalKey: await createKey(2),
        ciphertextBytes,
        ivBytes,
        additionalData: buildSignalAad(aadFields),
      }),
    ).toBeNull();
  });

  it('rejects an IV of the wrong length', async () => {
    const { signalKey, ciphertextBytes, ivBytes } = await encryptExample();
    for (const badIv of [ivBytes.slice(0, 11), new Uint8Array(16), new Uint8Array(0)]) {
      expect(
        await decryptSignalBytes({
          signalKey,
          ciphertextBytes,
          ivBytes: badIv,
          additionalData: buildSignalAad(aadFields),
        }),
      ).toBeNull();
    }
  });
});
