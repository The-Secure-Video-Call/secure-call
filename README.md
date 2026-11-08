# Secure Call

A secure 1-to-1 video calling web app. Media is peer-to-peer (WebRTC); the signaling server only
relays opaque, end-to-end encrypted messages. The room secret lives only in the URL fragment.
See [PLAN.md](PLAN.md) for the architecture and security design.

> Status: milestone M0 (repository and tooling). No call functionality yet.

## Run locally

Requirements: Node.js 22+ and [pnpm](https://pnpm.io) 10+.

```sh
pnpm install
pnpm --filter @secure-call/web dev   # web app on http://localhost:5173
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Layout

- `apps/web` – React + Vite client
- `packages/protocol` – zod schemas for signaling messages

The signaling server is a separate Python (Django + Channels) project:
[secure-call-backend](https://github.com/The-Secure-Video-Call/secure-call-backend).

## License

Copyright (C) 2026 Usman Khan and contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU Affero General Public License, version 3 only, as published by the Free Software Foundation.
See [LICENSE](LICENSE) for the full text.

If you run a modified version of this software as a network service, the AGPL requires you to offer
the source code of your modified version to its users.
