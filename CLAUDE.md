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

## Structure (keep it simple)

pnpm workspaces: `apps/web` and `packages/protocol`. The signaling server is a separate Python
repo, [secure-call-backend](https://github.com/The-Secure-Video-Call/secure-call-backend); its
`protocol/` folder (JSON Schema + example messages) is the contract the zod schemas must match.

Inside `apps/web/src/`:

- `pages/`: one file per screen, named `<Something>Page.tsx` (`LobbyPage`, `CallPage`).
  `App.tsx` only decides which page to show.
- `components/`: pieces of UI used by more than one page. Create it when the first one is needed.
- Logic, no UI, one folder per job: `crypto/` (secrets, room ID, call link), `media/` (camera and
  microphone), `signaling/` (WebSocket client), `rtc/` (WebRTC connection).
- Tests sit next to the file they test: `roomId.ts` → `roomId.test.ts`.
- No catch-all folders (`utils/`, `helpers/`, `lib/`, `common/`) and no deeper nesting unless the
  PR explains why.

`packages/protocol` is used straight from its TypeScript source (no build step).

`packages/protocol/contract/` is a byte-for-byte copy of the backend's `protocol/` folder: JSON
Schema in `schema/`, valid and invalid example messages in `fixtures/`, and the backend commit it
came from in `SOURCE`. Work from this copy (Claude's GitHub runs can't download from other repos).
Never edit it by hand: after the backend changes, run `pnpm protocol:sync` and commit the result.
A weekly check (`.github/workflows/contract-copy-check.yml`) opens an issue when the copy falls
behind the backend's `main`.

## Code conventions

- TypeScript in strict mode everywhere. No `any` without a comment explaining why.
- **No relative imports.** Import with `@/…` inside `apps/web` (`@/crypto/secret`,
  `@/pages/LobbyPage`) and `@protocol/…` for `packages/protocol`, never `./` or `../`.
  ESLint enforces this (`no-restricted-imports`).
- **Names say exactly what the value holds**, even if long: `selectedCameraDeviceId`,
  `isCallLinkCopied`, `roomIdBytes`, not `id`, `d`, `tmp`, `data` or `res`. Functions are named for
  what they do (`createNewCallLink`, `deriveRoomId`). Event handlers' parameters too:
  `changeEvent`, not `e`. ESLint rejects names shorter than 3 characters, except `i`/`j` loop
  counters and `id`/`ok`/`it`/`_`; it can't judge meaning, so that part is on you.
- Crypto code stays as small, pure, well-named functions in `apps/web/src/crypto/`.
- Every change to crypto, signaling or room logic needs unit tests, including at least one
  negative test (tampered, replayed or oversized input is rejected).
- Every change that adds, removes or alters a key, secret, algorithm or certificate (browser or
  backend) updates the key-management policy and inventory in `SECURITY.md` in the same PR. Say in
  the PR description that you checked it.

## The other repo

Every Claude run (tasks and reviews) has a read-only copy of secure-call-backend's latest `main` at
`.reference/secure-call-backend/`. Read it to see how the server really behaves (`signaling/protocol.py`, `signaling/consumers.py`,
`signaling/rooms.py`) before writing client code against it.

- Never edit or commit anything under `.reference/` (git ignores it anyway).
- If the work needs a change in secure-call-backend, don't work around it here: say in your reply
  what has to change there and why, so it can become an issue in that repo.

### When work in the two repos depends on each other

The two Claudes can't talk to each other or see each other's unmerged branches, only `main`.

1. **The message contract comes first.** The backend's `signaling/protocol.py` (exported to
   `protocol/`) is the agreed interface. Code against the contract, never against code that
   isn't merged yet. A contract change is made in the backend first; the web app follows after
   it is merged (`pnpm protocol:sync`).
2. **Check before you start.** If the issue says "Depends on" another issue, look in
   `.reference/secure-call-backend/` (or this repo) for what it needs. If it isn't on `main` yet,
   don't build a stand-in or guess: reply **"Blocked by <repo>#<issue>"**, list exactly what
   you need from it, and stop without pushing.
3. **Never change the other side's behaviour by assumption.** If you find the contract or the
   other repo's code doesn't support what your issue needs, say what has to change and why;
   the change becomes its own issue there, and your issue waits for it.
4. **Keep each side working on its own.** Merge order follows the dependencies (contract,
   then server, then client), and every PR must pass its own CI without the other's
   unmerged work.

## Working on issues

- One milestone checklist item from PLAN.md per pull request.
- Reference the issue in the PR description (`Closes #<number>`).
- Explain any security-relevant decision in the PR description.
- Run lint, type-check and tests before pushing (once they exist).
- For changes to crypto, signaling, WebRTC setup or the server, ask the
  `security-reviewer` subagent to review before finishing.
