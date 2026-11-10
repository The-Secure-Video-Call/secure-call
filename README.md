# Secure Call

A secure 1-to-1 video calling web app. Media is peer-to-peer (WebRTC); the signaling server only
relays opaque, end-to-end encrypted messages. The room secret lives only in the URL fragment.
See [PLAN.md](PLAN.md) for the architecture and security design.

> Status: milestone M0 (repository and tooling). No call functionality yet.

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

Dependencies are pinned to exact versions (`.npmrc` has `save-exact=true`), and Dependabot
proposes updates for them and for the pinned Actions every week, 7 days after a release. Node
in `.node-version` is bumped by hand. The pin check accepts one form only,
`uses: owner/repo@<40-character SHA> # vX.Y.Z` on its own line; flow style and other YAML forms
are reported, not read.

`package.json` overrides `minimatch` to 11.x for GHSA-g3hv-75wg-m249 (every 10.x is affected;
it reaches only eslint tooling). Remove the override once eslint and typescript-eslint accept
`minimatch` 11.0.1 or later, and bump it by hand until then.

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
