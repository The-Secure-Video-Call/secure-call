import { describe, expect, it } from 'vitest';
import { computeIntegrityAttributeValue } from './subresourceIntegrityHash.ts';

const helloBytes = new TextEncoder().encode('hello');

describe('computeIntegrityAttributeValue', () => {
  it('matches the known SHA-384 of "hello"', async () => {
    expect(await computeIntegrityAttributeValue(helloBytes)).toBe(
      'sha384-WeF0h3dEjGnea4ANejO7+5/xtGPkQ1TDVTvNucZm+pASWjx5+QOXvfX2oT3oKGhP',
    );
  });

  it('changes when one byte changes', async () => {
    const tamperedBytes = new TextEncoder().encode('hellp');
    expect(await computeIntegrityAttributeValue(tamperedBytes)).not.toBe(
      await computeIntegrityAttributeValue(helloBytes),
    );
  });

  it('can produce sha512', async () => {
    expect(await computeIntegrityAttributeValue(helloBytes, 'sha512')).toMatch(/^sha512-/);
  });
});
