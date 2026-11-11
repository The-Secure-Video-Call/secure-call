# Secure Video Call — Project Plan

A browser-based, 1-to-1 video calling app where **only the two people on the call can see and hear it**.
No accounts, no installs: one person creates a call, shares a link, the other opens it.

> Name: **Secure Video Call** (decided in #92). The repositories and packages keep their code
> names, `secure-call`, `secure-call-backend` and `@secure-call/*`.

---

## 1. Goals and non-goals

### Goals (v1)
- 1-to-1 video and audio calls in any modern browser (Chrome, Edge, Firefox, Safari; desktop and mobile).
- **End-to-end encrypted media**: audio and video go peer-to-peer and are encrypted between the two browsers. Our servers never get the media in readable form.
- **A server we don't have to trust with call setup**: the signaling server only forwards encrypted blobs it cannot read or alter without being caught.
- **A safety code** both people can compare out loud to confirm nobody is in the middle.
- Minimal metadata: no accounts, no call history, no stored messages, short-lived rooms.
- Works on restrictive networks (corporate Wi-Fi, mobile carriers) via a TURN relay.

### Non-goals (v1)
- Group calls (3+ people). Planned for later; see §9.
- Native mobile apps. The web app works in mobile browsers; a Flutter client can come later.
- Recording, contacts, scheduling, accounts.
- Protecting against a compromised device or a malicious browser extension.
- Hiding *that* two IP addresses talked from a network-level observer (that needs Tor-style anonymity, which is out of scope).

---

## 2. How a call works

```
 Alice's browser                 Signaling server              Bob's browser
 ───────────────                 ────────────────              ─────────────
 1. Click "New call"
    secret = 32 random bytes
    link   = https://app/#<secret>   (the #part never leaves the browser)
    roomId = HKDF(secret,"room")  ──join(roomId)──►  room created
    key    = HKDF(secret,"signal")
                                                     ◄──join(roomId)──  2. Bob opens link,
                                                                           derives same roomId + key
 3. Offer/answer/ICE candidates, each AES-GCM encrypted with key
    ──encrypted blob──►  server forwards blind  ──encrypted blob──►
    ◄─────────────────── (can't read or change) ◄──────────────────

 4. Direct WebRTC connection (DTLS-SRTP)  ◄═══════════════════════════════►
    (or via TURN relay, which sees only encrypted packets)

 5. Both screens show the same safety code, e.g.  🦊 🌵 🚀 🎈 🔑 🌙
    Alice and Bob read it to each other. Match = nobody in the middle.
```

---

## 3. Security design

### 3.1 Layers of protection

| Layer | What it does | What it defends against |
|---|---|---|
| **HTTPS + HSTS** | All traffic to our servers is TLS-encrypted | Network eavesdroppers, tampering with the app code in transit |
| **Secret in the URL fragment** | The `#secret` part of the link is never sent to any server (browsers don't send fragments) | The server learning what it needs to join or decrypt a call |
| **Key derivation (HKDF-SHA256)** | One secret produces a `roomId` (sent to the server) and a `signalKey` (never sent) | The server going from a room ID back to the key |
| **Encrypted signaling (AES-256-GCM)** | Every offer, answer and ICE candidate is encrypted and authenticated. Sender role + message counter go in the AAD | A malicious or hacked signaling server reading or swapping the connection details (MITM), replayed messages |
| **WebRTC DTLS-SRTP** | Mandatory media encryption, keys negotiated directly between the two browsers | Anyone on the network path, including the TURN relay |
| **Safety code** | Short code made from SHA-256 over both DTLS certificate fingerprints, sorted | A leaked link or a server that somehow got the secret and placed itself in the middle |
| **Room limits** | Max 2 participants, room expires after 10 min with nobody in it or 4 h in total, no persistence | Third parties joining, rooms living forever |
| **Privacy mode (optional)** | `iceTransportPolicy: "relay"` routes media through TURN so the other person never sees your IP | IP address exposure to the other participant |

### 3.2 Safety code details
0. **Commit first** (issue #94). Every peer connection gets a fresh ECDSA P-256 certificate, and each side's encrypted `hello` carries a SHA-256 commitment to its fingerprint. Every offer and answer of the other side must carry exactly the committed fingerprint, checked before it is applied, or the call ends. Without this, someone in the middle with the link could see both real fingerprints first and search about 2^18 certificates per side for a pair whose codes match. With it, his chance is 2^-36 per attempt (details in `docs/protocol.md` section 5). The 36-bit code is a short authentication string by design: it is less than the 128 bits OWASP ASVS V11.4.3 asks of a hash, a documented exception that the commitment makes acceptable.
1. Read the local DTLS fingerprint from `pc.currentLocalDescription.sdp` and the remote one from `pc.currentRemoteDescription.sdp` (`a=fingerprint:` lines: the descriptions the connection really uses). Both must be exactly the committed ones (step 0), or the call ends.
2. Sort the two fingerprints so both sides get the same order, then join them.
3. `SHA-256` the result and take the first 36 bits → 6 emoji from a fixed 64-emoji list (or the same six indices as two-digit numbers `00`–`63` for accessibility).
4. If someone is in the middle, each side sees a different pair of fingerprints, so the codes **will not match**.
5. UI: show the code with "Ask the other person to read their code. Do they match?" plus **Yes** / **No** buttons. **No** ends the call and shows a warning.

### 3.3 What the servers can still see (be honest about this in the docs)
- **Signaling server:** the derived room ID, both IP addresses, when the call starts and ends, and the size and timing of the encrypted messages.
- **TURN relay (when used):** both IP addresses, call length, and bandwidth. It cannot see the content.
- **Database (future accounts only):** account details a user gives us. Never room IDs, call times, IP addresses or message contents.
- **Logs outside the apps:** the reverse proxy in front of the signaling server (Nginx Proxy Manager) keeps no access log for `signal.securevideocall.com` (backend README, setup step 4); its error log can still name an address when a connection fails. The static host (ServerByt's shared Apache) and the CDN in front of it (StackCDN) keep their own access logs, with IP addresses, under the hosting company's retention: outside this project's control.
- **Nobody** sees: video, audio, chat, the room secret, or the safety code.
- Per-item levels, retention and logging rules: [docs/data-inventory.md](docs/data-inventory.md).

### 3.4 The web app trust problem
A web app is only as trustworthy as the JavaScript the server sends. If someone takes over the web host, they could ship code that leaks keys. Mitigations:
- Strict **Content-Security-Policy**: no inline scripts, no third-party scripts, `connect-src` limited to our own signaling and TURN hosts.
- **Subresource Integrity** on every script, and zero analytics or third-party tags.
- **Reproducible builds** with the hash of each release published on GitHub Releases, so anyone can check that the deployed app matches the source.
- Keep static hosting separate from the signaling server (a compromise of one doesn't give the other).
- Later: an installable PWA, or a desktop/mobile app with code signing.

### 3.5 Server hardening checklist
- Check the WebSocket `Origin` header and reject other origins.
- Validate every message against a schema (zod). Max message size 64 KB. Drop unknown message types.
- Rate limits: room joins per IP per minute, messages per connection per second.
- Short-lived TURN credentials (TURN REST API: HMAC with a shared secret, valid for the time the room has left, at most 4 h, so a credential never expires mid-call and never outlives the room's 4-hour limit; joins and credential issuing are rate-limited per IP) instead of a static username and password.
- No request logging of IPs or room IDs beyond in-memory rate-limit counters. Log levels default to `warn`.
- Security headers: `Strict-Transport-Security`, `Content-Security-Policy`, `Permissions-Policy: camera=(self), microphone=(self)`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy: same-origin`.

---

## 4. Tech stack

| Part | Choice | Why |
|---|---|---|
| Languages | **TypeScript** (web client) + **Python 3.14** (signaling server) | Each side uses the ecosystem that fits it best; a shared JSON Schema contract keeps them in sync |
| Web client | **React + Vite** | Fast dev loop, small production bundle, huge ecosystem |
| Styling | Tailwind CSS or plain CSS modules | No runtime CSS-in-JS needed |
| Crypto | **Web Crypto API** (built into browsers) | No third-party crypto library to audit; HKDF, AES-GCM, SHA-256 are all built in |
| Signaling server | **Python 3.14 + Django 6.1 + Channels (Daphne)**, in the separate repo [secure-call-backend](https://github.com/The-Secure-Video-Call/secure-call-backend) | Mature framework with built-in security settings; WebSockets through Channels |
| Database | **PostgreSQL 18** on the same machine as the backend (the Raspberry Pi while testing), connected but empty | Reserved for future user accounts; never holds call data; never reachable from the internet |
| Validation | **Pydantic 2** on the server (source of truth) + **zod** in the browser | Both are tested against the same JSON Schema and example messages |
| TURN/STUN | **coturn** (self-hosted) | Industry standard, supports time-limited credentials |
| Static hosting / CDN | **Shared Apache host** (ServerByt) behind **StackCDN** | Serves the built web app; `.htaccess` carries the CSP and security headers; deployed from CI over FTPS |
| Reverse proxy / TLS | **Nginx Proxy Manager** on a separate small machine on the home LAN, with Let's Encrypt certificates | Terminates TLS for `signal.securevideocall.com` and forwards over TLS to Daphne on the Pi, checking Daphne's certificate against our own local CA ([secure-call-backend#79](https://github.com/The-Secure-Video-Call/secure-call-backend/pull/79)); refuses plain HTTP except Let's Encrypt's challenge |
| Deployment | **Docker Compose on a Raspberry Pi** (Daphne, coturn, PostgreSQL); the backend image comes from GHCR, pulled by the Pi | No inbound access from GitHub; see [docs/architecture.md](docs/architecture.md) for every host, port and flow |
| Repos | **secure-call** (pnpm workspaces: web client + zod protocol package) and **secure-call-backend** (uv) | Node is only the web client's build tool; nothing in production runs on Node |
| Tests | **Vitest** (unit) + **Playwright** (two-browser end-to-end calls with fake camera); **pytest** for the server | Real call tests in CI without real hardware |
| CI | **GitHub Actions** | Lint, type-check, test, build, security scans on every PR |

---

## 5. Repository layout

Every host, port and communication flow of the deployment is listed in
[docs/architecture.md](docs/architecture.md).

Two repos in the GitHub organisation. The web client:

```
secure-call/
├── apps/
│   └── web/                    # React client
│       ├── src/
│       │   ├── pages/          # One file per screen: LobbyPage, CallPage, ...
│       │   ├── components/     # UI pieces shared by several pages (safety-code dialog, controls)
│       │   ├── crypto/         # Secret, room ID, HKDF, AES-GCM, safety code (pure functions, heavily tested)
│       │   ├── media/          # Camera and microphone
│       │   ├── rtc/            # RTCPeerConnection setup, "perfect negotiation", ICE restart
│       │   ├── signaling/      # WebSocket client, encrypt/decrypt wrapper
│       │   ├── App.tsx         # Picks the page for the current link
│       │   └── main.tsx
│       ├── e2e/                # Playwright tests: two browsers place a real call
│       ├── build-tools/        # Build-output check: no inline code, SRI hashes, security headers
│       └── public/.htaccess    # CSP and security headers for the static host
├── packages/
│   └── protocol/               # zod schemas + TypeScript types, tested against the backend's protocol fixtures
├── scripts/                    # Uptime check, deployed-site verification, pinned-actions check
├── docs/
│   ├── architecture.md         # Every host, port and flow of the deployment
│   ├── threat-model.md
│   ├── protocol.md
│   ├── data-inventory.md
│   ├── security-review.md      # OWASP ASVS 5.0 self-review
│   └── testing-mobile.md       # Manual phone checklist
├── .github/
│   ├── workflows/              # ci, deploy-web, uptime, Claude review, contract copy check
│   ├── dependabot.yml
│   └── CODEOWNERS
├── SECURITY.md                 # How to report vulnerabilities
├── LICENSE
└── README.md
```

The signaling server, [secure-call-backend](https://github.com/The-Secure-Video-Call/secure-call-backend):

```
secure-call-backend/
├── config/                     # Django settings (all from env), ASGI routing, URLs
├── signaling/
│   ├── consumers.py            # WebSocket consumer: rooms, 2-person limit, expiry, relaying
│   ├── protocol.py             # Pydantic message models (source of truth for the protocol)
│   ├── rate_limit.py
│   └── turn_credentials.py
├── protocol/
│   ├── schema/                 # JSON Schema exported from the Pydantic models
│   └── fixtures/               # valid/ and invalid/ example messages, used by both repos
├── tests/                      # pytest
├── deploy/raspberry-pi/        # Docker Compose (backend, PostgreSQL, coturn), firewall, certificates, update.sh
├── .github/workflows/          # CI: ruff, mypy, pytest, Django deploy checks, pip-audit
├── SECURITY.md
├── LICENSE
└── README.md
```

---

## 6. Signaling protocol (v1)

The server only understands the outer envelope. Everything in `payload` is an encrypted blob it can't read.
Every message also carries `v: 1`, the protocol version.

**Contract between the two repos:** the server's Pydantic models (`signaling/protocol.py` in
[secure-call-backend](https://github.com/The-Secure-Video-Call/secure-call-backend)) are the source of truth. They're exported as JSON Schema to
`protocol/schema/`, with valid and invalid example messages in `protocol/fixtures/`. The browser's
zod schemas in `packages/protocol` are tested against the same fixtures (set up in M1), so both
sides agree on what a valid message is.

**Client → server**
| Type | Fields | Meaning |
|---|---|---|
| `join` | `roomId` | Join or create a room |
| `signal` | `payload` (base64 ciphertext), `iv` | Forward to the other peer |
| `leave` | — | Leave the room |

**Server → client**
| Type | Fields | Meaning |
|---|---|---|
| `joined` | `role: "first" \| "second"`, `turn: {urls, username, credential}` | You're in; here are TURN credentials |
| `peer-joined` | — | The other person arrived (first peer starts the offer) |
| `signal` | `payload`, `iv` | Encrypted message from the other peer |
| `peer-left` | — | The other person left |
| `error` | `code: "room-full" \| "rate-limited" \| "bad-message"` | Something went wrong |

**Inside the encrypted payload** (only the browsers see this):
`{ kind: "hello" | "offer" | "answer" | "candidate" | "bye", data, seq }`, where `seq` is a counter that blocks replayed messages. `hello` carries a fresh random session ID and is the first message each side sends; the AAD layout and session binding are described in `apps/web/src/crypto/signalEncryption.ts`.

---

## 7. Milestones

Each milestone ends with something you can demo. Issues in GitHub can map 1:1 to the bullets.

### M0 — Repository and tooling
- [x] Create `secure-call` repo in the org; add `README.md`, `LICENSE`, `SECURITY.md`, `CODEOWNERS`
- [x] pnpm workspace with `apps/web` and `packages/protocol`; Python backend repo `secure-call-backend` (uv, Django + Channels)
- [x] ESLint, Prettier, TypeScript strict mode
- [x] GitHub Actions: install → lint → type-check → test → build
- [x] Turn on Dependabot, CodeQL, secret scanning, and branch protection on `main` (PR + passing CI required)

**Demo:** green CI on an empty app.

### M1 — Basic working call (not yet hardened)
- [x] Signaling server (`secure-call-backend`): rooms, 2-person limit, forward messages, peer-joined/left events
- [x] Lobby page: "New call" button generates a link; camera/mic preview; device picker
- [x] Call page: local and remote video, mute, camera on/off, hang up
- [x] WebRTC with the "perfect negotiation" pattern (handles both sides offering at once)
- [x] STUN from our own coturn (`stun:turn.securevideocall.com:3478`)

**Demo:** two browser tabs on the same machine have a video call.

### M2 — End-to-end security layer
- [x] Generate the secret, derive `roomId` and `signalKey` with HKDF (Web Crypto)
- [x] Encrypt/decrypt every signaling message with AES-256-GCM; sender role + `seq` in AAD; reject replays
- [x] Safety code from both DTLS fingerprints; match/no-match dialog
- [x] Room expiry timers; nothing written to disk
- [x] Unit tests for every crypto function, including a "tampered message is rejected" test
- [x] Write `docs/threat-model.md` and `docs/protocol.md`

**Demo:** a server log shows only unreadable ciphertext; changing one byte makes the call refuse to connect.

### M3 — Works on real-world networks
- [x] Self-hosted coturn with time-limited HMAC credentials issued by the signaling server
- [x] "Privacy mode" toggle (relay-only, hides your IP from the other person)
- [x] Reconnect: ICE restart on network change (Wi-Fi ↔ mobile), WebSocket auto-reconnect
- [x] Connection quality indicator (from `getStats()`: packet loss, round-trip time)
- [x] Mobile layout and testing on iOS Safari and Android Chrome

**Demo:** a call between a laptop on Wi-Fi and a phone on mobile data.

### M4 — Hardening
- [x] Strict CSP, SRI, all security headers from §3.5 (`apps/web/public/.htaccess`, checked by `check:build`)
- [x] Origin check, Pydantic validation, size limits, rate limiting on the signaling server
- [x] Playwright end-to-end test: two browsers with fake cameras complete a call in CI
- [x] `pnpm audit` in CI; pin dependency versions (and every GitHub Action by commit)
- [x] Reproducible build, with release hashes (`SHA256SUMS`) and an SBOM published on GitHub Releases
- [x] Self-review against OWASP ASVS 5.0, Level 2 ([docs/security-review.md](docs/security-review.md)); every finding fixed or recorded as an exception
- [ ] An outside security review, if someone can be found

**Demo:** CI runs a full encrypted call end-to-end on every PR.

### M5 — Deploy
The deployment differs from the original VPS plan; [docs/architecture.md](docs/architecture.md) has every host, port and flow.
- [x] Domain `securevideocall.com`; the static site on a shared Apache host (ServerByt) behind StackCDN
- [x] Signaling, coturn and PostgreSQL with Docker Compose on a Raspberry Pi 5 at home (secure-call-backend `deploy/raspberry-pi`), behind Nginx Proxy Manager on a Pi Zero 2 W; TLS on every hop
- [x] Router forwards: 80/443/tcp to the proxy; 3478/udp+tcp, 5349/tcp and the TURN relay UDP range to the Pi 5; firewall rules on the Pi's Docker bridges (secure-call-backend#87)
- [x] Health check endpoint and uptime monitoring (no personal data in metrics): `.github/workflows/uptime.yml`
- [x] Deploy workflow from GitHub Actions: every push to `main`, after `production` approval, deploys over FTPS and publishes a GitHub Release (`.github/workflows/deploy-web.yml`); the Pi installs only attested backend images (`update.sh`)

**Demo:** public URL; call a friend on another network.

### M6 — Polish and accessibility
- [x] Apply the decided project name, Secure Video Call (#76)
- [ ] Design tokens and light/dark theming (#75)
- [ ] Logo, favicon, touch icons and theme-color (#77)
- [ ] Inline-SVG icons on the existing controls (#78)
- [ ] Carry the lobby's device choices into the call (#79)
- [ ] Lobby flow: start your own call, copy feedback, Web Share, paste a link (#80)
- [ ] Focus management, focus-visible styles, keyboard shortcuts and live regions (#81)
- [ ] Every user-visible string in one typed module (#82)
- [ ] Rewrite `docs/testing-mobile.md` and run the full phone pass (#83)

**Demo:** the themed, icon-based app passes the full phone checklist on iOS Safari and Android Chrome.

### M7 — Call features
- [ ] Call timer (#84)
- [ ] Copy or share the link again while waiting (#85)
- [ ] In-call microphone and speaker switching (#86)
- [ ] Fullscreen and picture-in-picture (#87)
- [ ] Screen sharing (#88)
- [ ] Text chat over the data channel (#89)
- [ ] Remote mute and camera-off indicators (#90)
- [ ] Extend `docs/testing-mobile.md` and run the pass again (#91)

**Demo:** a phone call with chat, screen sharing and device switching passes the extended checklist on iOS Safari and Android Chrome.

---

## 8. Testing strategy

| Level | Tool | What it covers |
|---|---|---|
| Unit | Vitest (browser), pytest (server) | Crypto (HKDF vectors, AES-GCM round trip, tamper/replay rejection), safety-code generation; on the server: room logic, rate limiter, protocol models |
| Integration | pytest + Channels `WebsocketCommunicator` | Join/leave/full-room/expiry flows, malformed message handling |
| End-to-end | Playwright (Chromium with `--use-fake-device-for-media-stream`, plus Firefox) | Two browser contexts open the same link, connect, see matching safety codes, hang up |
| Manual | Real devices | Safari iOS, Android Chrome, different networks, relay-only mode |
| Security | CodeQL, Dependabot, `pnpm audit`, `pip-audit`, Django `check --deploy`, manual review | Known vulnerabilities, risky code patterns |

---

## 9. Later (after v1)

- **In-call text chat** over an `RTCDataChannel` (peer-to-peer, already DTLS-encrypted).
- **Screen sharing** (`getDisplayMedia`).
- **Installable PWA** for a more app-like feel.
- **Flutter mobile client** (`flutter_webrtc`) speaking the same signaling protocol, so the server doesn't change.
- **Group calls**: add an SFU (e.g. LiveKit or mediasoup) and a second encryption layer with **Encoded Transforms** (`RTCRtpScriptTransform`) so the SFU forwards video it can't decrypt.
- **Accounts and contacts**, ideally with passkeys and end-to-end-encrypted contact lists. The PostgreSQL connection is already in place (secure-call-backend); the tables and what they hold get decided here first.

---

## 10. Decisions still open

| Decision | Options | Suggested default |
|---|---|---|
| Project name | Keep "Secure Call" / a new name | **Decided: Secure Video Call** (#92): it matches `securevideocall.com` and the GitHub organization, and "Secure Call" is already the name of other calling apps. Code names stay `secure-call` |
| License | MIT (permissive) / AGPL-3.0 (forks must share source) | **Decided: AGPL-3.0-only** (see `LICENSE`) |
| Hosting provider | Hetzner, DigitalOcean, AWS Lightsail, etc. | **Decided:** the static site on ServerByt behind StackCDN; the backend and coturn on a Raspberry Pi at home (see M5) |
| Safety code format | Emoji / digits / words | Emoji, with digits as an accessible alternative |
| Room expiry times | — | 10 min idle, 4 h max |
