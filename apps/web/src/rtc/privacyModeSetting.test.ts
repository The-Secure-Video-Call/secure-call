import { describe, expect, it } from 'vitest';
import {
  PRIVACY_MODE_STORAGE_KEY,
  readPrivacyModeSetting,
  savePrivacyModeSetting,
} from '@/rtc/privacyModeSetting';

function createMemoryStorage(initialValue?: string) {
  const values = new Map<string, string>();
  if (initialValue !== undefined) values.set(PRIVACY_MODE_STORAGE_KEY, initialValue);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const throwingStorage = {
  getItem: () => {
    throw new Error('storage blocked');
  },
  setItem: () => {
    throw new Error('storage blocked');
  },
};

describe('privacy mode setting', () => {
  it('is off by default', () => {
    expect(readPrivacyModeSetting(createMemoryStorage())).toBe(false);
  });

  it('remembers on and off', () => {
    const storage = createMemoryStorage();
    savePrivacyModeSetting(true, storage);
    expect(readPrivacyModeSetting(storage)).toBe(true);
    savePrivacyModeSetting(false, storage);
    expect(readPrivacyModeSetting(storage)).toBe(false);
  });

  it('treats any unexpected stored value as off', () => {
    expect(readPrivacyModeSetting(createMemoryStorage('true'))).toBe(false);
    expect(readPrivacyModeSetting(createMemoryStorage('<script>'))).toBe(false);
  });

  it('does not throw when storage is blocked or missing', () => {
    expect(readPrivacyModeSetting(throwingStorage)).toBe(false);
    expect(() => savePrivacyModeSetting(true, throwingStorage)).not.toThrow();
    expect(readPrivacyModeSetting(null)).toBe(false);
    expect(() => savePrivacyModeSetting(true, null)).not.toThrow();
  });
});
