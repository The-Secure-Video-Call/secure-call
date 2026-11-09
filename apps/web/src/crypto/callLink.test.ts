import { describe, expect, it } from 'vitest';
import { buildCallLink, readFragmentFromLocationHash } from '@/crypto/callLink';

describe('call links', () => {
  it('puts the secret only in the fragment', () => {
    const callLink = new URL(buildCallLink('https://securevideocall.com', 'abc'));
    expect(callLink.hash).toBe('#abc');
    expect(callLink.search).toBe('');
    expect(callLink.pathname).toBe('/');
  });

  it('reads the fragment without its leading #', () => {
    expect(readFragmentFromLocationHash('#abc')).toBe('abc');
    expect(readFragmentFromLocationHash('')).toBe('');
  });
});
