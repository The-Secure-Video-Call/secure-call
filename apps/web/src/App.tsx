import { decodeSecret } from './crypto/secret';
import { Lobby } from './ui/Lobby';
import { fragmentOf } from './ui/media';

export const APP_TITLE = 'Secure Call';

export function App() {
  const fragment = fragmentOf(window.location.hash);
  if (fragment === '') return <Lobby />;
  if (decodeSecret(fragment) === null) {
    return (
      <main>
        <h1>{APP_TITLE}</h1>
        <p role="alert">This call link is invalid. Ask for a new one.</p>
      </main>
    );
  }
  // The call flow is built in the call page issue; for now just show that we detected a link.
  return (
    <main>
      <h1>{APP_TITLE}</h1>
      <p>Joining…</p>
    </main>
  );
}
