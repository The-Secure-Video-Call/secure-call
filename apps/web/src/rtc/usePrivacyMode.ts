import { useCallback, useState } from 'react';
import { readPrivacyModeSetting, savePrivacyModeSetting } from '@/rtc/privacyModeSetting';

/** The privacy mode switch state, remembered per browser. */
export function usePrivacyMode() {
  const [isPrivacyModeOn, setIsPrivacyModeOnState] = useState(() => readPrivacyModeSetting());
  const setIsPrivacyModeOn = useCallback((newIsPrivacyModeOn: boolean) => {
    setIsPrivacyModeOnState(newIsPrivacyModeOn);
    savePrivacyModeSetting(newIsPrivacyModeOn);
  }, []);
  return { isPrivacyModeOn, setIsPrivacyModeOn };
}
