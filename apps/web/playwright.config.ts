// End-to-end tests (PLAN.md section 8, M4 demo): real browsers with fake cameras complete an
// encrypted call through a real signaling server, under the production CSP.
//
// Playwright starts two servers before the tests:
// - the signaling backend, run from source with uv (a checkout of secure-call-backend in
//   E2E_BACKEND_DIR, default ../../.reference/secure-call-backend as in CI), with production
//   settings (DEBUG off) and only this test site's origin allowed; no TURN, no database;
// - e2e/serveBuiltSite.ts, serving dist/ with the headers of dist/.htaccess.
// Build first with the local signaling URL:
//   VITE_SIGNALING_URL=ws://localhost:8000/ws/signal/ pnpm build && pnpm test:e2e
//
// All browsers share one IP (127.0.0.1), and the backend allows 20 joins per IP per minute, so
// the suite stays well under that: one worker, and Firefox runs only the @every-browser call.
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const SITE_ORIGIN = 'http://localhost:4173';
const SIGNALING_PORT = 8000;
const isCi = process.env.CI !== undefined;
const backendFolder = resolve(
  import.meta.dirname,
  process.env.E2E_BACKEND_DIR ?? '../../.reference/secure-call-backend',
);
const fakeMediaArguments = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: isCi ? 1 : 0,
  forbidOnly: isCi,
  reporter: isCi ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: SITE_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // Locally, E2E_CHROMIUM_CHANNEL=chrome uses the installed Chrome instead of a download.
        ...(process.env.E2E_CHROMIUM_CHANNEL ? { channel: process.env.E2E_CHROMIUM_CHANNEL } : {}),
        launchOptions: { args: fakeMediaArguments },
      },
    },
    {
      name: 'firefox',
      grep: /@every-browser/,
      use: {
        browserName: 'firefox',
        launchOptions: {
          firefoxUserPrefs: {
            'media.navigator.streams.fake': true,
            'media.navigator.permission.disabled': true,
          },
        },
      },
    },
  ],
  webServer: [
    {
      command: `uv run --locked --no-dev --directory "${backendFolder}" daphne -v 0 -b 127.0.0.1 -p ${SIGNALING_PORT} config.asgi:application`,
      url: `http://127.0.0.1:${SIGNALING_PORT}/healthz`,
      env: {
        DJANGO_SECRET_KEY: randomBytes(32).toString('base64url'),
        DJANGO_ALLOWED_HOSTS: 'localhost,127.0.0.1',
        SIGNALING_ALLOWED_ORIGINS: SITE_ORIGIN,
        // Plain HTTP on localhost: no redirect to HTTPS (healthz is exempt anyway).
        DJANGO_SECURE_SSL_REDIRECT: '0',
      },
      reuseExistingServer: !isCi,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node e2e/serveBuiltSite.ts',
      url: `${SITE_ORIGIN}/`,
      env: { E2E_SITE_PORT: '4173', E2E_SIGNALING_ORIGIN: `ws://localhost:${SIGNALING_PORT}` },
      reuseExistingServer: !isCi,
      timeout: 30_000,
    },
  ],
});
