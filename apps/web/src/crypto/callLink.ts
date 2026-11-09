/** Build the shareable call link. The secret goes only in the fragment, which browsers never send. */
export function buildCallLink(siteOrigin: string, encodedRoomSecret: string): string {
  return `${siteOrigin}/#${encodedRoomSecret}`;
}

/** The fragment of a location hash without its leading "#" ("" when there is none). */
export function readFragmentFromLocationHash(locationHash: string): string {
  return locationHash.startsWith('#') ? locationHash.slice(1) : locationHash;
}
