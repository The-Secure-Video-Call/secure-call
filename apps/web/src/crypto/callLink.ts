/** Build the shareable call link. The secret goes only in the fragment, which browsers never send. */
export function buildCallLink(siteOrigin: string, encodedRoomSecret: string): string {
  return `${siteOrigin}/#${encodedRoomSecret}`;
}

/** The fragment of a location hash without its leading "#" ("" when there is none). */
export function readFragmentFromLocationHash(locationHash: string): string {
  return locationHash.startsWith('#') ? locationHash.slice(1) : locationHash;
}

/**
 * Replaces (not pushes) the current history entry with the start page, so neither the address bar
 * nor any history entry keeps the secret. The page itself keeps running with the secret in memory.
 */
export function replaceHistoryEntryWithStartPage(
  browserHistory: Pick<History, 'replaceState'>,
  currentLocation: Pick<Location, 'href'>,
): void {
  // An absolute same-origin URL: a path like "//host/" would be read as another origin and throw.
  const startPageUrl = new URL(currentLocation.href);
  startPageUrl.hash = '';
  browserHistory.replaceState(null, '', startPageUrl.href);
}
