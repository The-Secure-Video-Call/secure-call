import { describe, expect, it } from 'vitest';
import {
  buildCallLink,
  readFragmentFromLocationHash,
  replaceHistoryEntryWithStartPage,
} from '@/crypto/callLink';

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

describe('removing the secret from the history', () => {
  const secretFragment = 'SECRET-FRAGMENT';

  /** A tiny stand-in for the browser's history: the list of URLs, the last one is current. */
  function createFakeHistory() {
    const entryUrls = ['/', `/#${secretFragment}`];
    return {
      entryUrls,
      replaceState(_state: unknown, _unused: string, url?: string | URL | null) {
        entryUrls[entryUrls.length - 1] = String(url);
      },
    };
  }

  const site = 'https://securevideocall.com';

  it('replaces the current entry with the start page and keeps the others', () => {
    const fakeHistory = createFakeHistory();
    replaceHistoryEntryWithStartPage(fakeHistory, { href: `${site}/#${secretFragment}` });
    expect(fakeHistory.entryUrls).toEqual(['/', `${site}/`]);
    expect(fakeHistory.entryUrls.join('')).not.toContain(secretFragment);
  });

  it('keeps the path and query but never a fragment', () => {
    const fakeHistory = createFakeHistory();
    replaceHistoryEntryWithStartPage(fakeHistory, { href: `${site}/app?x=1#${secretFragment}` });
    expect(fakeHistory.entryUrls.at(-1)).toBe(`${site}/app?x=1`);
  });

  it('negative: a path starting with two slashes stays on this site', () => {
    const fakeHistory = createFakeHistory();
    replaceHistoryEntryWithStartPage(fakeHistory, {
      href: `${site}//evil.example/#${secretFragment}`,
    });
    expect(new URL(String(fakeHistory.entryUrls.at(-1))).origin).toBe(site);
    expect(fakeHistory.entryUrls.join('')).not.toContain(secretFragment);
  });
});
