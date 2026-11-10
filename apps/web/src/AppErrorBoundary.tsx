import { Component, type ReactNode } from 'react';
import { APP_ERROR_MESSAGE, recoverFromRenderError } from '@/appErrorRecovery';
import { APP_TITLE } from '@/appTitle';

type AppErrorBoundaryState = { hasRenderFailed: boolean };

/**
 * Top-level error boundary. After a render error the whole app below it is unmounted (which hangs
 * up the call and stops the camera and microphone), the secret is removed from the address bar,
 * and only a fixed message is shown. The error is never stored, shown or logged.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { hasRenderFailed: false };

  // Deliberately ignores its argument: nothing from the error may reach state or the page.
  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasRenderFailed: true };
  }

  override componentDidCatch(): void {
    recoverFromRenderError(window.history, window.location);
  }

  override render() {
    if (!this.state.hasRenderFailed) return this.props.children;
    return (
      <main>
        <h1>{APP_TITLE}</h1>
        <p role="alert">{APP_ERROR_MESSAGE}</p>
        <a href="/">Start a new call</a>
      </main>
    );
  }
}
