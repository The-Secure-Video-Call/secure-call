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

A web app is only as trustworthy as the files the server sends (PLAN.md §3.4). Two things let
anyone check that securevideocall.com serves exactly the code in this repository:

1. **Every deploy publishes its hashes.** After each upload, the deploy workflow publishes a
   GitHub Release named `web-<first 12 characters of the commit>` with `SHA256SUMS`: the
   SHA-256 of every uploaded file (`index.html`, `.htaccess` and everything under `assets/`).
2. **The build is reproducible.** The same commit always builds to byte-identical files, at
   any path and time; CI checks this on every PR (`reproducible-build` job).

**Check the live site** against the newest release (Node 22+, nothing to install):

```sh
node scripts/verify-deployed.mjs                       # newest web-<commit> release
node scripts/verify-deployed.mjs --release web-<commit>
```

It downloads the release's `SHA256SUMS`, fetches the live `index.html` and every asset, and
fails if any hash differs, if `index.html` loads anything not in the release, or if the live
security headers differ from `apps/web/public/.htaccess` at the release's commit (`.htaccess`
itself is not served, so its headers are compared instead).

**Rebuild a release yourself** instead of trusting its `SHA256SUMS`:

```sh
git clone https://github.com/The-Secure-Video-Call/secure-call.git && cd secure-call
git checkout <commit from the release>
# Node from .node-version and pnpm from "packageManager" in package.json
pnpm install --frozen-lockfile
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" pnpm build
(cd apps/web/dist && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > my-SHA256SUMS
diff my-SHA256SUMS <(curl -fsSL https://github.com/The-Secure-Video-Call/secure-call/releases/download/web-<commit>/SHA256SUMS)
node scripts/verify-deployed.mjs --sums my-SHA256SUMS --commit <commit>
```

**Limits.** A check covers what that one request received: a compromised host could serve
different files to different people, or change them after you looked. The check also trusts
GitHub for the release and the repository. Closing that gap needs an installable app with
signed releases (PLAN.md §9, later).
