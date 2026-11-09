import { describe, expect, it } from 'vitest';
import { buildCallLink, describeMediaError, fragmentOf } from './media';

describe('describeMediaError', () => {
  it('explains denied permission', () => {
    expect(describeMediaError(new DOMException('x', 'NotAllowedError'))).toMatch(/denied/);
  });
  it('explains missing devices', () => {
    expect(describeMediaError(new DOMException('x', 'NotFoundError'))).toMatch(/No camera/);
  });
  it('falls back for unknown errors', () => {
    expect(describeMediaError(new Error('boom'))).toMatch(/Could not start/);
  });
});

describe('links', () => {
  it('puts the secret only in the fragment', () => {
    const link = buildCallLink('https://securevideocall.com', 'abc');
    const url = new URL(link);
    expect(url.hash).toBe('#abc');
    expect(url.search).toBe('');
    expect(url.pathname).toBe('/');
  });
  it('strips the leading #', () => {
    expect(fragmentOf('#abc')).toBe('abc');
    expect(fragmentOf('')).toBe('');
  });
});
