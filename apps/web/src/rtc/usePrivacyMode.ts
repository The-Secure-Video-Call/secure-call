import { useCallback, useState } from 'react';
import { readPrivacyModeSetting, savePrivacyModeSetting } from '@/rtc/privacyModeSetting';

/**
 * The last choice made in this page session. When `localStorage` is blocked, this keeps the choice
 * from the lobby when the call page opens, so privacy mode is never silently off.
 */
let choiceMadeInThisPageSession: boolean | null = null;

/** The privacy mode switch state, remembered per browser. */
export function usePrivacyMode() {
  const [isPrivacyModeOn, setIsPrivacyModeOnState] = useState(
    () => choiceMadeInThisPageSession ?? readPrivacyModeSetting(),
  );
  const setIsPrivacyModeOn = useCallback((newIsPrivacyModeOn: boolean) => {
    choiceMadeInThisPageSession = newIsPrivacyModeOn;
    setIsPrivacyModeOnState(newIsPrivacyModeOn);
    savePrivacyModeSetting(newIsPrivacyModeOn);
  }, []);
  return { isPrivacyModeOn, setIsPrivacyModeOn };
}
