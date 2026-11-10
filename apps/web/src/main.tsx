import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import { AppErrorBoundary } from '@/AppErrorBoundary';
import '@/styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');
// React logs caught errors to the console by default. Errors can carry call details, so these
// handlers deliberately ignore their arguments and log nothing.
createRoot(rootElement, {
  onCaughtError() {},
  onUncaughtError() {},
  onRecoverableError() {},
}).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
