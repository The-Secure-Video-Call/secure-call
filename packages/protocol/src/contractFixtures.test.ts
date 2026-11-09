import { describe, expect, it } from 'vitest';
import {
  SIGNAL_PAYLOAD_MAX_LENGTH,
  clientMessageSchema,
  parseServerMessage,
  serverMessageSchema,
} from '@protocol/index';

// Vite inlines the vendored backend fixtures as raw text at test time.
// (Declared locally: this package does not load vite/client types.)
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: '?raw'; import: 'default'; eager: true },
    ): Record<string, string>;
  }
}

const rawTextByFixturePath = import.meta.glob('../contract/fixtures/**/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function loadFixtures(fixtureFolder: string): [string, string][] {
  const matchingFixtures = Object.entries(rawTextByFixturePath).filter(([fixturePath]) =>
    fixturePath.includes(`/fixtures/${fixtureFolder}/`),
  );
  expect(matchingFixtures.length).toBeGreaterThan(0);
  return matchingFixtures;
}

describe.each([
  ['client', clientMessageSchema],
  ['server', serverMessageSchema],
] as const)('%s fixtures', (direction, messageSchema) => {
  it.each(loadFixtures(`${direction}/valid`))('accepts %s', (_fixturePath, rawText) => {
    expect(messageSchema.safeParse(JSON.parse(rawText)).success).toBe(true);
  });
  it.each(loadFixtures(`${direction}/invalid`))('rejects %s', (_fixturePath, rawText) => {
    expect(messageSchema.safeParse(JSON.parse(rawText)).success).toBe(false);
  });
});

describe('parseServerMessage', () => {
  it('returns the message for every valid server fixture', () => {
    for (const [, rawText] of loadFixtures('server/valid')) {
      expect(parseServerMessage(rawText).ok).toBe(true);
    }
  });
  it('rejects every invalid server fixture', () => {
    for (const [, rawText] of loadFixtures('server/invalid')) {
      expect(parseServerMessage(rawText).ok).toBe(false);
    }
  });
  it('rejects non-JSON text and non-string input', () => {
    expect(parseServerMessage('{not json').ok).toBe(false);
    expect(parseServerMessage(new ArrayBuffer(8)).ok).toBe(false);
  });
});

describe('envelope fixtures', () => {
  it.each(loadFixtures('invalid'))('rejects %s in both directions', (_fixturePath, rawText) => {
    const fixtureJson: unknown = JSON.parse(rawText);
    expect(clientMessageSchema.safeParse(fixtureJson).success).toBe(false);
    expect(serverMessageSchema.safeParse(fixtureJson).success).toBe(false);
  });
});

describe('protocol version', () => {
  it('rejects a message without v or with another version', () => {
    expect(clientMessageSchema.safeParse({ type: 'ping' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ v: 2, type: 'ping' }).success).toBe(false);
    expect(serverMessageSchema.safeParse({ type: 'pong' }).success).toBe(false);
  });
});

describe('limits', () => {
  it('accepts a payload of the maximum size and rejects one character more', () => {
    const maxPayload = 'A'.repeat(SIGNAL_PAYLOAD_MAX_LENGTH);
    const signalAtLimit = { v: 1, type: 'signal', payload: maxPayload, iv: 'AAAAAAAAAAAAAAAA' };
    expect(clientMessageSchema.safeParse(signalAtLimit).success).toBe(true);
    const signalOverLimit = { ...signalAtLimit, payload: `${maxPayload}A` };
    expect(clientMessageSchema.safeParse(signalOverLimit).success).toBe(false);
  });
  it('accepts roomId lengths 22 to 43 only', () => {
    const joinWithRoomId = (roomId: string) => ({ v: 1, type: 'join', roomId });
    expect(clientMessageSchema.safeParse(joinWithRoomId('a'.repeat(22))).success).toBe(true);
    expect(clientMessageSchema.safeParse(joinWithRoomId('a'.repeat(43))).success).toBe(true);
    expect(clientMessageSchema.safeParse(joinWithRoomId('a'.repeat(21))).success).toBe(false);
    expect(clientMessageSchema.safeParse(joinWithRoomId('a'.repeat(44))).success).toBe(false);
  });
  it('rejects a signal without iv or with a null iv, in both directions', () => {
    const signalWithoutIv = { v: 1, type: 'signal', payload: 'AAAA' };
    for (const signalMessage of [signalWithoutIv, { ...signalWithoutIv, iv: null }]) {
      expect(serverMessageSchema.safeParse(signalMessage).success).toBe(false);
      expect(clientMessageSchema.safeParse(signalMessage).success).toBe(false);
    }
    expect(parseServerMessage(JSON.stringify(signalWithoutIv)).ok).toBe(false);
  });
  it('accepts the room-expired error code', () => {
    const roomExpiredError = { v: 1, type: 'error', code: 'room-expired' };
    expect(serverMessageSchema.safeParse(roomExpiredError).success).toBe(true);
  });
});
