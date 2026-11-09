import { describe, expect, it } from 'vitest';
import { protocolVersionSchema } from '@protocol/protocolVersion';

describe('protocolVersionSchema', () => {
  it('accepts version 1', () => {
    expect(protocolVersionSchema.parse(1)).toBe(1);
  });
  it('rejects other versions', () => {
    expect(protocolVersionSchema.safeParse(2).success).toBe(false);
  });
});
