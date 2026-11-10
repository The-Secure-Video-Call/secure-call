import { describe, expect, it, vi } from 'vitest';
import { APP_ERROR_MESSAGE, recoverFromRenderError } from '@/appErrorRecovery';

const SECRET_FRAGMENT = 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldC0';

describe('APP_ERROR_MESSAGE', () => {
  it('is the fixed message', () => {
    expect(APP_ERROR_MESSAGE).toBe('Something went wrong. Start a new call.');
  });

  it('is a constant that cannot contain error details', () => {
    const renderError = new Error(`boom ${SECRET_FRAGMENT}`);
    expect(APP_ERROR_MESSAGE).not.toContain(renderError.message);
    expect(APP_ERROR_MESSAGE).not.toContain(SECRET_FRAGMENT);
  });
});

describe('recoverFromRenderError', () => {
  it('replaces the history entry with the start page, without the secret', () => {
    const replaceState = vi.fn();
    recoverFromRenderError({ replaceState }, { href: `https://call.example/#${SECRET_FRAGMENT}` });
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, '', 'https://call.example/');
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain(SECRET_FRAGMENT);
  });

  it('does not throw or log when removing the secret fails', () => {
    const consoleSpies = (['log', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const failingHistory = {
      replaceState: () => {
        throw new Error(`failed with ${SECRET_FRAGMENT}`);
      },
    };
    expect(() =>
      recoverFromRenderError(failingHistory, { href: `https://call.example/#${SECRET_FRAGMENT}` }),
    ).not.toThrow();
    consoleSpies.forEach((consoleSpy) => {
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
