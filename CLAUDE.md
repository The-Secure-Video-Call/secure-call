# CLAUDE.md

Secure 1-to-1 video calling web app. The full plan (architecture, security design,
signaling protocol, milestones) is in **PLAN.md**. Read it before starting any task.

## Security ground rules (never break these)

- The room secret lives only in the URL fragment (`#...`). Never log it, store it, put it
  in a query string, or send it anywhere. Only the derived `roomId` may leave the browser.
- Use the browser's **Web Crypto API** only. No third-party crypto libraries.
- No third-party scripts, CDNs, web fonts, analytics or trackers in the web app.
  Everything is bundled and served from our own origin.
- The signaling server treats every `payload` as opaque. It never decrypts, parses or logs it.
- Validate every signaling message with the zod schemas in `packages/protocol` (the server does
  the same with Pydantic in secure-call-backend).
- Never weaken CSP, security headers, rate limits or room limits to make something work.
  If a change seems to need that, stop and explain why in the PR instead.
- Never commit secrets. TURN secrets and API keys come from environment variables.

## Code conventions

- TypeScript in strict mode everywhere. No `any` without a comment explaining why.
- pnpm workspaces: `apps/web`, `packages/protocol`. The signaling server is a separate Python
  repo, [secure-call-backend](https://github.com/The-Secure-Video-Call/secure-call-backend); its `protocol/` folder (JSON Schema + example
  messages) is the contract the zod schemas must match.
- Crypto code stays as small, pure, well-named functions in `apps/web/src/crypto/`.
- Every change to crypto, signaling or room logic needs unit tests, including at least one
  negative test (tampered, replayed or oversized input is rejected).

## Working on issues

- One milestone checklist item from PLAN.md per pull request.
- Reference the issue in the PR description (`Closes #<number>`).
- Explain any security-relevant decision in the PR description.
- Run lint, type-check and tests before pushing (once they exist).
- For changes to crypto, signaling, WebRTC setup or the server, ask the
  `security-reviewer` subagent to review before finishing.
