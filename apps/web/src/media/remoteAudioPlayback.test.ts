import { describe, expect, it, vi } from 'vitest';
import { tryPlayMediaElement } from '@/media/remoteAudioPlayback';

describe('tryPlayMediaElement', () => {
  it('reports playing when play() works', async () => {
    expect(await tryPlayMediaElement({ play: vi.fn(async () => {}) })).toBe('playing');
  });
  it('shows the tap button when play() is blocked, instead of failing silently', async () => {
    const blockedPlay = vi.fn(async () => {
      throw new DOMException('blocked', 'NotAllowedError');
    });
    expect(await tryPlayMediaElement({ play: blockedPlay })).toBe('needs-tap');
  });
  it('shows the tap button for any other failure too', async () => {
    const brokenPlay = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await tryPlayMediaElement({ play: brokenPlay })).toBe('needs-tap');
  });
  it('does not show the button when a newer stream interrupted play()', async () => {
    const interruptedPlay = vi.fn(async () => {
      throw new DOMException('interrupted', 'AbortError');
    });
    expect(await tryPlayMediaElement({ play: interruptedPlay })).toBe('superseded');
  });
});
