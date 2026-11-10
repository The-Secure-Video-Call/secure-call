import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseServerMessage } from '@protocol/index';

describe('zod configuration for the strict CSP', () => {
  it('turns on jitless as soon as the protocol package is imported', () => {
    expect(z.config().jitless).toBe(true);
  });

  it('never calls Function while parsing, valid or not', () => {
    const functionSpy = vi.spyOn(globalThis, 'Function');

    expect(parseServerMessage('{"v":1,"type":"pong"}').ok).toBe(true);
    expect(parseServerMessage('{"v":1,"type":"pong","extra":1}').ok).toBe(false);

    expect(functionSpy).not.toHaveBeenCalled();
    functionSpy.mockRestore();
  });
});
