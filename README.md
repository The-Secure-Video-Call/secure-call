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
- `apps/signaling` – Node.js signaling server
- `packages/protocol` – shared zod schemas
