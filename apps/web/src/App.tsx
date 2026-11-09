import { useCallback, useEffect, useMemo, useState } from 'react';
import { readFragmentFromLocationHash } from '@/crypto/callLink';
import { decodeSecret } from '@/crypto/secret';
import { CallPage } from '@/pages/CallPage';
import { InvalidCallLinkPage } from '@/pages/InvalidCallLinkPage';
import { LobbyPage } from '@/pages/LobbyPage';

/** Picks the page for the current link: no fragment → lobby, a valid secret → the call. */
export function App() {
  const [fragmentText, setFragmentText] = useState(() =>
    readFragmentFromLocationHash(window.location.hash),
  );

  useEffect(() => {
    const updateFragment = () =>
      setFragmentText(readFragmentFromLocationHash(window.location.hash));
    window.addEventListener('hashchange', updateFragment);
    return () => window.removeEventListener('hashchange', updateFragment);
  }, []);

  const returnToLobby = useCallback(() => {
    // Replace (not push) the history entry so the back button does not bring the secret back.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setFragmentText('');
  }, []);

  // Memoised: a new array on every render would restart the call.
  const roomSecret = useMemo(() => decodeSecret(fragmentText), [fragmentText]);
  if (fragmentText === '') return <LobbyPage />;
  if (roomSecret === null) return <InvalidCallLinkPage />;
  return <CallPage key={fragmentText} roomSecret={roomSecret} onReturnToLobby={returnToLobby} />;
}
