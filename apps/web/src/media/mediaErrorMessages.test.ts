import { describe, expect, it } from 'vitest';
import { describeMediaError } from '@/media/mediaErrorMessages';

describe('describeMediaError', () => {
  it('explains denied permission', () => {
    expect(describeMediaError(new DOMException('denied', 'NotAllowedError'))).toMatch(/denied/);
  });
  it('explains missing devices', () => {
    expect(describeMediaError(new DOMException('missing', 'NotFoundError'))).toMatch(/No camera/);
  });
  it('falls back for unknown errors', () => {
    expect(describeMediaError(new Error('boom'))).toMatch(/Could not start/);
  });
});
