import { readFragmentFromLocationHash } from '@/crypto/callLink';
import { decodeSecret } from '@/crypto/secret';
import { InvalidCallLinkPage } from '@/pages/InvalidCallLinkPage';
import { JoiningCallPage } from '@/pages/JoiningCallPage';
import { LobbyPage } from '@/pages/LobbyPage';

/** Picks the page for the current link: no fragment → lobby, a valid secret → the call. */
export function App() {
  const fragmentText = readFragmentFromLocationHash(window.location.hash);
  if (fragmentText === '') return <LobbyPage />;
  if (decodeSecret(fragmentText) === null) return <InvalidCallLinkPage />;
  return <JoiningCallPage />;
}
