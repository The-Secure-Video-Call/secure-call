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
