# Secure Video Call

A secure 1-to-1 video calling web app. Media is peer-to-peer (WebRTC); the signaling server only
relays opaque, end-to-end encrypted messages. The room secret lives only in the URL fragment.
See [PLAN.md](PLAN.md) for the architecture and security design, and
[docs/architecture.md](docs/architecture.md) for every host, port and flow of the deployment.

> Status: milestones M0–M4 (hardening) are done. The app is live at
> [securevideocall.com](https://securevideocall.com).

## Run locally

Requirements: Node.js 22+ (CI and the deploy use the exact version in `.node-version`) and
[pnpm](https://pnpm.io) 10+.

```sh
pnpm install
pnpm --filter @secure-call/web dev   # web app on http://localhost:5173
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

CI also runs these, and the deploy runs the audits too:

```sh
node scripts/check-pinned-actions.mjs          # every GitHub Action pinned to a commit SHA
node --test 'scripts/*.test.mjs'               # tests for that check
pnpm audit --prod --audit-level moderate       # production dependencies: moderate or worse fails
pnpm audit --audit-level high                  # dev tooling too: high or worse fails
```

CI also checks that the build is reproducible on Linux and macOS (`reproducible-build`), and
every deploy publishes the hashes of what it uploaded, and an SBOM of the production dependencies,
as an attested `web-<commit>` GitHub Release; `node scripts/verify-deployed.mjs` checks the live
site against it (SECURITY.md).

Dependencies are pinned to exact versions (`.npmrc` has `save-exact=true`), and Dependabot
proposes updates for them and for the pinned Actions every week, 7 days after a release. Node
in `.node-version` is bumped by hand. The pin check accepts one form only,
`uses: owner/repo@<40-character SHA> # vX.Y.Z` on its own line; flow style and other YAML forms
are reported, not read.

`package.json` overrides `minimatch` to 11.x for GHSA-g3hv-75wg-m249 (every 10.x is affected;
it reaches only eslint tooling). Remove the override once eslint and typescript-eslint accept
`minimatch` 11.0.1 or later, and bump it by hand until then.

### End-to-end tests

`apps/web/e2e/` holds Playwright tests in which real browsers with fake cameras make an
encrypted call through a real signaling server, under the production CSP from
`apps/web/public/.htaccess` (only `connect-src` points at the local server). They check:

- a full call: both sides connect, see each other's video, show the same safety code and
  verify it, and a hang-up reaches the other side (Chromium and Firefox);
- a tampered and a replayed signaling message each end the call before any media flows;
- a third person is told the call is full;
- privacy mode with no relay fails closed and sends no signaling message;
- no CSP or Trusted Types violation and no uncaught error anywhere.

CI runs them on every PR (the `e2e` job). To run them locally you need
[uv](https://docs.astral.sh/uv/) and a checkout of
[secure-call-backend](https://github.com/The-Secure-Video-Call/secure-call-backend); Playwright
starts the backend from it and serves the built app:

```sh
VITE_SIGNALING_URL=ws://localhost:8000/ws/signal/ pnpm build
cd apps/web
pnpm exec playwright install chromium firefox   # once; or E2E_CHROMIUM_CHANNEL=chrome
E2E_BACKEND_DIR=/path/to/secure-call-backend pnpm test:e2e
```

All browsers share one IP and the backend allows 20 joins per IP per minute, so the suite runs
with one worker and Firefox runs only the full call.

## Layout

- `apps/web` – React + Vite client
- `packages/protocol` – zod schemas for signaling messages

The signaling server is a separate Python (Django + Channels) project:
[secure-call-backend](https://github.com/The-Secure-Video-Call/secure-call-backend).

## Deploying

Every merge to `main` builds the web app and uploads it to
[securevideocall.com](https://securevideocall.com) (ServerByt hosting) over encrypted FTP
(`.github/workflows/deploy-web.yml`). Each deploy waits for approval in the repo's
**production** environment: open the run in the Actions tab and click **Review deployments**.

- Settings: environment variables `FTP_SERVER` and `FTP_USERNAME`, environment secret
  `FTP_PASSWORD`. The FTP account can only reach `public_html`.
- Security headers: `apps/web/public/.htaccess`, deployed with the site.
- A deploy can also be started by hand: Actions → **Deploy web app** → **Run workflow**.

## License

Copyright (C) 2026 Usman Khan and contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU Affero General Public License, version 3 only, as published by the Free Software Foundation.
See [LICENSE](LICENSE) for the full text.

If you run a modified version of this software as a network service, the AGPL requires you to offer
the source code of your modified version to its users.
