# Security Policy

## Reporting a vulnerability

Please report vulnerabilities **privately** using GitHub private vulnerability reporting:
go to the repository's **Security** tab, then **Report a vulnerability**.

Do not open a public issue or pull request for a suspected vulnerability, and do not include
real room links (the part after `#` is a secret) in any report.

We aim to acknowledge reports within a few days and will coordinate disclosure with you.

## Checking the live security headers

Anyone can see the headers the site sends:

```sh
curl -sI https://securevideocall.com/
```

Look for `Content-Security-Policy` (no `unsafe-inline`, no `unsafe-eval`, `connect-src` limited
to the site itself and `wss://signal.securevideocall.com`, `require-trusted-types-for 'script'`),
`Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin` and `X-Frame-Options: DENY`. The source of truth is
`apps/web/public/.htaccess`; the build check (`pnpm --filter @secure-call/web check:build`)
verifies the built copy.

## Subresource Integrity (SRI)

Every `<script>` and `<link rel="stylesheet|modulepreload|preload">` in the built `index.html`
carries `integrity="sha384-..."` and `crossorigin`, added by a build plugin.

- **What it covers:** the browser refuses to run or apply a file whose hash differs from the one
  in `index.html`. It guards against a changed asset next to an unchanged `index.html`, and
  against a stale or corrupted cached file.
- **What it does not cover:** chunks loaded later by `import()` or `React.lazy` (the app has
  none today), and an attacker who can replace `index.html` together with the assets. That
  case, a compromised host, can only be caught by comparing against the published hashes of the
  reproducible build.

## Verify the app you're running

A web app is only as trustworthy as the files the server sends (PLAN.md §3.4). Three things let
anyone check that securevideocall.com serves exactly the code in this repository:

1. **Every deploy publishes its hashes.** After each upload, the deploy workflow publishes a
   GitHub Release named `web-<first 12 characters of the commit>` with `SHA256SUMS`: the
   SHA-256 of every uploaded file (`index.html`, `.htaccess` and everything under `assets/`).
2. **The release is attested.** `SHA256SUMS` is signed (Sigstore, keyless) with a certificate
   that names the deploy workflow, `main` and the commit. A release made any other way, by
   another workflow or a person with write access, cannot carry that attestation.
3. **The build is reproducible.** The same commit builds to byte-identical files on Linux and
   macOS, at different paths, times, time zones and locales. CI checks this on every PR
   (`reproducible-build`). Every deploy also builds twice, on Ubuntu and on macOS, and uploads
   nothing unless both builds match. That catches tampering specific to one runner or OS. It
   cannot catch code that recognises a deploy and behaves the same on both: only a rebuild
   outside GitHub Actions, like the one below, can.

**Check the live site** against the newest release. It needs Node 22+ and the
[GitHub CLI](https://cli.github.com/), signed in (`gh auth login`), for the attestation:

```sh
node scripts/verify-deployed.mjs                       # newest web-<commit> release
node scripts/verify-deployed.mjs --release web-<commit>
node scripts/verify-deployed.mjs --skip-provenance     # without gh: files and headers only
```

It fails unless all of this holds:

- the release's tag names its commit, the tag points at that commit, and the commit is on
  `main`;
- `SHA256SUMS` is attested by `deploy-web.yml` on `main` **for that commit**, so a genuine
  `SHA256SUMS` of an older commit attached to a newer release fails too (skipped only with
  `--skip-provenance`, which the result then says);
- the `.htaccess` hash in `SHA256SUMS` matches `apps/web/public/.htaccess` at that commit;
- the live `index.html` and every asset hash exactly as listed;
- `index.html` loads nothing that is not in the release;
- every response carries exactly the security headers that `.htaccess` sets (`.htaccess` itself
  is not served, so its headers are checked instead), and none sends `Refresh`;
- `index.html` is never cached as `immutable`.

Anything the script can't read fails the check, instead of being skipped.

**Check who made the release by hand** (what the script runs for you):

```sh
curl -fsSLO https://github.com/The-Secure-Video-Call/secure-call/releases/download/web-<commit>/SHA256SUMS
gh attestation verify SHA256SUMS --repo The-Secure-Video-Call/secure-call \
  --signer-workflow The-Secure-Video-Call/secure-call/.github/workflows/deploy-web.yml \
  --source-ref refs/heads/main --source-digest <full 40-character commit> \
  --deny-self-hosted-runners
```

**Rebuild a release yourself** instead of trusting its `SHA256SUMS`, on Linux or macOS (on
Windows, use WSL; `.gitattributes` keeps line endings as committed). Build with a clean
environment (`env -i`) and no `apps/web/.env.local`, so nothing from your own setup, such as
`VITE_SIGNALING_URL`, changes the output:

```sh
git clone https://github.com/The-Secure-Video-Call/secure-call.git && cd secure-call
git checkout <commit from the release>
# Node from .node-version and pnpm from "packageManager" in package.json
pnpm install --frozen-lockfile
env -i PATH="$PATH" HOME="$HOME" SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" pnpm build
(cd apps/web/dist && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) > my-SHA256SUMS
diff my-SHA256SUMS <(curl -fsSL https://github.com/The-Secure-Video-Call/secure-call/releases/download/web-<commit>/SHA256SUMS)
node scripts/verify-deployed.mjs --sums my-SHA256SUMS --commit <commit>
```

**Limits.**

- **One request, one moment.** A check covers what that one request received. A compromised
  host can serve different files to different people, or change them after you looked. The
  script is easy to tell apart from a browser (its user agent and request headers differ).
- **Not seen:** files on the server that `index.html` doesn't load, and anything already in your
  browser (a cached copy, a service worker).
- **The scan of `index.html`** is a simple scan, not an HTML parser. `index.html` is pinned by
  its hash anyway.
- **Trust in GitHub.** The check trusts GitHub for the release, the repository and the
  attestation's signing chain. It also trusts the deploy workflow's own runners: the two builds
  inside one GitHub Actions run are not independent of GitHub.
- **Reproducible doesn't mean safe.** A rebuild proves the files come from the commit. It
  doesn't prove the commit or its dependencies are safe: code that is malicious the same way
  everywhere is reproduced by every build.
- **Rollbacks.** Re-running an older deploy makes the live site match that older release. Check
  it with `--release web-<that commit>`.
- **Host cache.** After a header change, the host's cache can keep serving unchanged assets with
  their old headers until it is purged. The check reports that as a mismatch.

Closing the first gap needs an installable app with signed releases (PLAN.md §9, later).

## Key management

This is the key-management policy and the inventory of every key, secret and certificate in use
(OWASP ASVS 5.0 V11.1.1 and V11.1.2). It covers this repository and
[secure-call-backend](https://github.com/The-Secure-Video-Call/secure-call-backend). Each row is
based on the code in the file it names. The backend's `SECURITY.md` links here.

### Policy

1. **Only the Web Crypto API in the browser, and the Python standard library on the server.** No
   third-party crypto libraries (CLAUDE.md). Browser keys come from `crypto.getRandomValues` or
   the browser's own key generation; server secrets come from `secrets` or from an operator
   running `openssl rand` / `secrets.token_urlsafe`.
2. **One key, one job.** A key is used only for the purpose in its row. Keys derived from the room
   secret use HKDF with a different `info` label per job, and the signaling AAD and the
   fingerprint commitment carry versioned labels.
3. **Secrets live only where the inventory says.** Browser secrets stay in memory (the room secret
   also in the URL fragment). Server secrets come from environment variables (coturn gets the TURN secret on its command line), are never
   committed, never logged and never sent to clients. Keys derived in the browser are imported
   as non-extractable `CryptoKey`s and the temporary raw bytes are zeroed.
4. **Rotation.** Per-call keys are never rotated: they are made new for each call or peer
   connection and thrown away. Long-lived server secrets are rotated by the operator on any
   suspected compromise, when someone who held them leaves access, and at least once a year. The
   rows say how, and what stops working meanwhile.
5. **Compromise.** Rotate or revoke at once as the row says, then check the host and logs for
   misuse. If users could be affected, publish a GitHub security advisory. Report a suspected
   compromise privately (see "Reporting a vulnerability").
6. **Review on every crypto change.** A pull request that adds, removes or changes a key,
   algorithm, certificate or secret updates this inventory in the same pull request (CLAUDE.md).
   A new weak or legacy algorithm is allowed only as a documented exception below, with the
   reason and an exit plan.

### Inventory: web app (this repository)

| Item                                                                        | Where it lives, who holds it                                                                                                                                         | Algorithm and size                                                                                                             | Allowed use                                                                                                                                   | Made, rotated, revoked                                                                                                                                  | If compromised                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Room secret** (`apps/web/src/crypto/secret.ts`)                           | URL fragment of the call link and the memory of each browser in the call. Held by the people who have the link. Never sent to a server, logged or stored by the app. | 32 random bytes (256 bits) from `crypto.getRandomValues`, base64url                                                            | Input to HKDF only (room ID, `signalKey`). Never a key itself.                                                                                | Made when someone starts a call. Not rotated: a new call is a new link. Revoked by abandoning the link; the server closes a room after at most 4 hours. | Anyone with the link can join the room and read its signaling. End the call and start a new one with a new link. The safety code does not help here: a link holder is a valid peer. If an unexpected person appears, hang up. |
| **Room ID** (`apps/web/src/crypto/roomId.ts`)                               | Sent to the signaling server to find the room. Public by design.                                                                                                     | HKDF-SHA256, empty salt, info `room`, 16 bytes, base64url                                                                      | Naming a room on the server. Not a key.                                                                                                       | Derived on every join; changes only with the secret.                                                                                                    | Reveals nothing about the secret. Knowing it only lets someone try to join a room that is limited to two people and rate-limited.                                                                                             |
| **`signalKey`** (`apps/web/src/crypto/signalKey.ts`, `signalEncryption.ts`) | Memory of each browser, as a non-extractable `CryptoKey`.                                                                                                            | HKDF-SHA256, empty salt, info `signal`, 32 bytes, used as AES-256-GCM: random 12-byte IV per message, 128-bit tag, 62-byte AAD | `encrypt` and `decrypt` of signaling payloads.                                                                                                | Derived from the room secret when the call page opens; dropped when it closes. Not rotated inside a call.                                               | Same as the room secret, which it is derived from: start a new call.                                                                                                                                                          |
| **Session IDs** (`signalEncryption.ts`, `createSessionId`)                  | Memory of each browser; sent to the other side in the encrypted `hello`. Not secret from the other person.                                                           | 16 random bytes (128 bits) from `crypto.getRandomValues`                                                                       | Binding every signaling message to one session through the AAD, and choosing the sender role. Not a key.                                      | New for every peer connection.                                                                                                                          | Nothing to revoke: a recorded message fails to authenticate in a later session.                                                                                                                                               |
| **Fingerprint commitment** (`apps/web/src/crypto/fingerprintCommitment.ts`) | Sent in the encrypted `hello`.                                                                                                                                       | SHA-256 over `secure-call/fp-commit/v1`, a newline and the fingerprint; 32 bytes                                               | Committing to the DTLS fingerprint before any SDP is sent. Not a key.                                                                         | New for every peer connection.                                                                                                                          | Not secret.                                                                                                                                                                                                                   |
| **Safety code** (`apps/web/src/crypto/safetyCode.ts`)                       | Computed in each browser and shown on screen; people compare it out loud.                                                                                            | First 36 bits of SHA-256 over the two sorted DTLS fingerprints, as six symbols                                                 | Showing that nobody is in the middle. Not a key.                                                                                              | Computed again for every peer connection.                                                                                                               | If the codes differ, hang up. The 36-bit length is a short authentication string by design; the commitment above keeps an attack at 2^-36 per attempt (`docs/protocol.md`).                                                   |
| **DTLS certificate** (`apps/web/src/rtc/localCertificate.ts`)               | Memory of one browser tab. Generated by that browser; never stored or sent (only its fingerprint goes into the SDP).                                                 | ECDSA P-256 from `RTCPeerConnection.generateCertificate`                                                                       | Authenticating the DTLS handshake of one peer connection. The media keys (DTLS-SRTP) come from that handshake and are managed by the browser. | A new certificate for every peer connection, used once. Revoked by closing the connection.                                                              | Gone when the tab closes. It is never reused, so there is nothing to rotate.                                                                                                                                                  |

### Inventory: signaling and TURN servers (secure-call-backend)

| Item                                                                                                 | Where it lives, who holds it                                                                                                                                                                                                                                           | Algorithm and size                                                                                                                               | Allowed use                                                                                                       | Made, rotated, revoked                                                                                                                                                         | If compromised                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **TURN shared secret** (`TURN_SHARED_SECRET`; `config/settings.py`, `signaling/turn_credentials.py`) | The backend's environment, and coturn's command line (`--static-auth-secret`, filled from `.env` by `compose.yaml`, so visible in the container's arguments on the host). Same value, set by the operator. Not in any repository, never logged, never sent to clients. | Random, 32 bytes (`openssl rand -base64 32`); the key of an HMAC-SHA1                                                                            | Signing TURN credentials only.                                                                                    | Made by the operator and set in both places. Rotated by changing it in both and restarting both; credentials made with the old value stop working (they live at most 4 hours). | Anyone with it can make valid credentials and use the relay until it is rotated: rotate at once. The relay sees only DTLS-SRTP packets and coturn denies private and loopback peers. |
| **TURN credential** (`signaling/turn_credentials.py`)                                                | Sent to the browser in `joined`; held in memory during the call.                                                                                                                                                                                                       | `base64(HMAC-SHA1(shared secret, "<expiry>:<16 random bytes>"))`. See the exceptions below.                                                      | Logging in to coturn for one connection.                                                                          | Made for each join, valid for the time the room has left, at most 4 hours (`TURN_CREDENTIAL_TTL_SECONDS`). Not revocable; it expires.                                          | Valid until it expires. Rotating the shared secret cuts it off earlier.                                                                                                              |
| **TURN long-term key** (computed by coturn and the browser)                                          | Memory of coturn and of the browser's WebRTC stack. Never stored or sent.                                                                                                                                                                                              | `MD5(username ":" realm ":" password)`, the key of the STUN `MESSAGE-INTEGRITY` HMAC-SHA1. See the exceptions below.                             | Protecting STUN/TURN messages on port 3478.                                                                       | Derived from each short-lived credential and changes with it.                                                                                                                  | Proves only possession of a credential that expires within hours. It protects no media.                                                                                              |
| **Rate-limit HMAC key** (`signaling/rate_limits.py`, `_client_key_secret`)                           | Memory of the backend process only. Never stored or logged.                                                                                                                                                                                                            | 32 random bytes (`secrets.token_bytes`); HMAC-SHA256                                                                                             | Turning a client IP into a counter key, so raw addresses are not kept in memory. Nothing else.                    | Made at every process start. Rotated by a restart (counters start empty).                                                                                                      | It only lets someone with the process memory test whether a guessed address is in the counters. Restart the server.                                                                  |
| **Django `SECRET_KEY`** (`DJANGO_SECRET_KEY`; `config/settings.py`)                                  | Environment of the backend, set by the operator. Required when `DJANGO_DEBUG` is off; in development a throwaway key is made per process.                                                                                                                              | Random, 50 bytes (`secrets.token_urlsafe(50)`, about 67 characters); the development fallback is Django's 50-character `get_random_secret_key()` | Django's signing functions. The backend has no accounts, sessions or signed data, so nothing depends on it today. | Made by the operator. Rotated by changing it and restarting; nothing is invalidated.                                                                                           | Rotate it. Nothing signed with it exists today.                                                                                                                                      |
| **TLS certificate of the site** (`securevideocall.com`)                                              | Static host and CDN, run by the hosting provider. Configured on the host, not in a repository.                                                                                                                                                                         | Let's Encrypt, RSA-2048 (as observed in `docs/security-review.md`)                                                                               | HTTPS for the static site.                                                                                        | Issued and renewed by the host. Revoked through the host or Let's Encrypt.                                                                                                     | Have the host revoke and reissue it. HSTS stops a plain-HTTP fallback.                                                                                                               |
| **TLS certificate of the signaling host** (`signal.securevideocall.com`)                             | The reverse proxy in front of the backend, run by the operator. Configured on the host, not in a repository.                                                                                                                                                           | Let's Encrypt, ECDSA (as observed in `docs/security-review.md`)                                                                                  | HTTPS and `wss://` for signaling.                                                                                 | Requested and renewed by the proxy. Revoked through Let's Encrypt.                                                                                                             | Revoke and reissue it. HSTS is on.                                                                                                                                                   |

The two TLS rows describe what the ASVS review observed on the live hosts. They are not in code,
so check them against the live certificates whenever the hosting changes.

### Accepted exceptions: TURN uses SHA-1 and MD5

Both come from the TURN protocol, not from our choice, and neither protects call content.

- **HMAC-SHA1 for the TURN REST credential.** coturn's `use-auth-secret` mode computes and
  compares `HMAC-SHA1(secret, username)`, so the backend must produce exactly that
  (`signaling/turn_credentials.py`). It is used as a message authentication code, where SHA-1's
  collision weakness does not apply.
- **MD5 in the long-term credential key.** STUN/TURN long-term credentials derive the integrity
  key as MD5 over `username:realm:password` and sign with HMAC-SHA1. The password here is a
  160-bit HMAC output that expires within hours, so MD5 is not exposed to guessing, and no
  media key depends on it.
- **Why this is acceptable:** media is protected by DTLS-SRTP between the browsers, which the
  relay cannot read. A broken TURN credential only gives use of the relay for a short time.
  Credentials expire with the room (4 hours at most), are random for each connection and are
  rate-limited.
- **Plan:** move to the SHA-256 variants that RFC 8489 defines (the SHA-256 password algorithm
  and `MESSAGE-INTEGRITY-SHA256`) once coturn and the browsers' WebRTC stacks support them. We
  do not control the browser side. Check coturn and browser support whenever coturn is updated,
  then change this exception and `signaling/turn_credentials.py` together.

### Planned: rows to be added by their own pull requests

- TLS certificates for PostgreSQL:
  [secure-call-backend#57](https://github.com/The-Secure-Video-Call/secure-call-backend/issues/57).
- The proxy-to-backend hop:
  [secure-call-backend#59](https://github.com/The-Secure-Video-Call/secure-call-backend/issues/59).
- TURN over TLS on port 5349:
  [secure-call-backend#58](https://github.com/The-Secure-Video-Call/secure-call-backend/issues/58).

Operational passwords that are not crypto keys of the app (the PostgreSQL password and the FTPS
deploy credentials) are not in this inventory yet.
