import { useCallback, useEffect, useMemo, useState } from 'react';
import { readFragmentFromLocationHash, replaceHistoryEntryWithStartPage } from '@/crypto/callLink';
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

  /**
   * Takes the secret out of the address bar and the history entry (replace, not push, so the back
   * button does not bring it back). It does not touch `fragmentText`: the call page keeps its own
   * copy of the secret in memory, so the ended screen stays up with its message.
   */
  const removeSecretFromAddressBar = useCallback(() => {
    replaceHistoryEntryWithStartPage(window.history, window.location);
  }, []);

  const returnToLobby = useCallback(() => {
    removeSecretFromAddressBar();
    setFragmentText('');
  }, [removeSecretFromAddressBar]);

  // Memoised: a new array on every render would restart the call.
  const roomSecret = useMemo(() => decodeSecret(fragmentText), [fragmentText]);
  if (fragmentText === '') return <LobbyPage />;
  if (roomSecret === null) return <InvalidCallLinkPage />;
  return (
    <CallPage
      key={fragmentText}
      roomSecret={roomSecret}
      onSessionEnded={removeSecretFromAddressBar}
      onReturnToLobby={returnToLobby}
    />
  );
}
