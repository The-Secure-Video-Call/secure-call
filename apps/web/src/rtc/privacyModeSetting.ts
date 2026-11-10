export const PRIVACY_MODE_STORAGE_KEY = 'secure-call.privacyMode';

type PrivacyModeStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** localStorage can throw (blocked, private mode); the setting is only a convenience. */
function getBrowserStorage(): PrivacyModeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Off unless the person turned it on earlier in this browser. Never throws. */
export function readPrivacyModeSetting(
  storage: PrivacyModeStorage | null = getBrowserStorage(),
): boolean {
  try {
    return storage?.getItem(PRIVACY_MODE_STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

/** Remembers the choice; failing to store it is fine. Never throws. */
export function savePrivacyModeSetting(
  isPrivacyModeOn: boolean,
  storage: PrivacyModeStorage | null = getBrowserStorage(),
): void {
  try {
    storage?.setItem(PRIVACY_MODE_STORAGE_KEY, isPrivacyModeOn ? 'on' : 'off');
  } catch {
    // Only a convenience: the switch still works for this page.
  }
}
