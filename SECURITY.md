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
