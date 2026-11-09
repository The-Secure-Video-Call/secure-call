import { APP_TITLE } from '@/appTitle';

/** Shown when the link's fragment is not a valid room secret. */
export function InvalidCallLinkPage() {
  return (
    <main>
      <h1>{APP_TITLE}</h1>
      <p role="alert">This call link is invalid. Ask for a new one.</p>
    </main>
  );
}
