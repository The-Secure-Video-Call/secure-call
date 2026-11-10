import { replaceHistoryEntryWithStartPage } from '@/crypto/callLink';

/** The only text shown after a render error. It never includes the error or anything from it. */
export const APP_ERROR_MESSAGE = 'Something went wrong. Start a new call.';

/**
 * Takes the secret out of the address bar and the history entry after a render error.
 * The error itself is deliberately not an input: it may contain call details and is never read.
 * Ending the call (session, camera, microphone) is done by React unmounting the failed tree, which
 * runs the cleanups of `useCallSession` and the media hooks.
 */
export function recoverFromRenderError(
  browserHistory: Pick<History, 'replaceState'>,
  currentLocation: Pick<Location, 'href'>,
): void {
  try {
    replaceHistoryEntryWithStartPage(browserHistory, currentLocation);
  } catch {
    // Nothing more can be done here, and the error is not logged on purpose.
  }
}
