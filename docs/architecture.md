# Architecture: hosts, ports and flows

The current list of every communication flow of the deployed service (ASVS V13.1.1). The design
and the reasons behind it are in [PLAN.md](../PLAN.md); what each party can see is in
[threat-model.md](threat-model.md); the message format is in [protocol.md](protocol.md).

No addresses of the home network and no machine names are listed here, on purpose: this
repository is public. Roles are named instead ("the Pi", "the proxy machine").

## Parts

| Part                      | Where                                                                  | What it does                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static web app            | Shared Apache host (ServerByt), `securevideocall.com`, behind StackCDN | Serves `index.html`, the hashed assets and `.htaccess` (CSP and security headers). No server code of ours runs there.                                           |
| StackCDN                  | In front of the static host                                            | Caches and serves the static site over HTTPS. It sees every request for the site (IP addresses, paths), but never the URL fragment, which browsers do not send. |
| Nginx Proxy Manager (NPM) | A separate small machine on the home LAN                               | Terminates TLS for `signal.securevideocall.com` and forwards plain HTTP and WebSocket to Daphne. Security headers come from Daphne/Django.                      |
| Daphne (signaling server) | Main Pi, Docker container                                              | Django + Channels. Relays opaque, end-to-end encrypted messages between the two browsers of a room. Also hands out short-lived TURN credentials.                |
| coturn                    | Main Pi, Docker container on its own network                           | STUN/TURN relay for callers behind strict NATs.                                                                                                                 |
| PostgreSQL                | Main Pi, Docker container                                              | Connected but empty; reserved for future accounts. Never holds call data.                                                                                       |
| GHCR                      | `ghcr.io`                                                              | Hosts the backend container image.                                                                                                                              |
| GitHub Actions            | GitHub's runners                                                       | Builds, tests and deploys the web app; monitors uptime.                                                                                                         |

## Flows

| #   | From                               | To                                                                              | Port and protocol                                                                                | Carries                                                                                   | Protection                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Browser                            | StackCDN, then the static host                                                  | 443 TCP, HTTPS (port 80 is open for redirects to HTTPS)                                          | The web app files                                                                         | TLS; HSTS, CSP and the other headers from `.htaccess`; SRI on every script and style                                                                                                                                                                                                                                                                                              |
| 2   | Browser                            | NPM (`signal.securevideocall.com`)                                              | 443 TCP, HTTPS and secure WebSocket (port 80 is open for redirects to HTTPS)                     | Signaling messages (payloads are end-to-end encrypted), `/healthz`                        | TLS at NPM; Origin check, message size limit, rate limits and the 2-person room limit at Daphne                                                                                                                                                                                                                                                                                   |
| 3   | NPM                                | Daphne on the main Pi                                                           | 8001 TCP on the Pi's LAN address, **plain HTTP**                                                 | The same signaling traffic, after TLS is removed                                          | Home LAN only; payloads are still end-to-end encrypted. **Not encrypted in transit yet: see Planned changes.**                                                                                                                                                                                                                                                                    |
| 4   | Browser                            | coturn on the main Pi (through the router)                                      | 3478 UDP and TCP, plus the UDP relay range 49160-49200                                           | STUN, TURN allocations, and relayed SRTP/DTLS media                                       | Short-lived HMAC credentials; media is already encrypted by WebRTC (DTLS-SRTP). The TURN control channel itself is not encrypted yet: see Planned changes. coturn denies relaying to private, loopback and link-local ranges (checked by the backend's CI test); per-credential quotas cap abuse, and an allocation can outlive its credential if the client keeps refreshing it. |
| 5   | Browser                            | Browser                                                                         | WebRTC, UDP (ICE), direct when possible, otherwise via flow 4                                    | Audio and video                                                                           | DTLS-SRTP, plus the end-to-end safety code to detect a man in the middle                                                                                                                                                                                                                                                                                                          |
| 6   | Daphne                             | PostgreSQL                                                                      | 5432 TCP, inside the Pi's Docker network only                                                    | Nothing about calls (empty database, future accounts)                                     | Not published to the internet. **Not encrypted in transit yet: see Planned changes.**                                                                                                                                                                                                                                                                                             |
| 7   | CI (deploy job)                    | The static host                                                                 | FTP over TLS (FTPS) on the FTP control port, passive-mode data connections, certificate verified | `assets/`, `index.html`, `.htaccess`                                                      | Explicit TLS forced on control and data connections; credentials only in the approval-gated `production` environment; two independent byte-identical builds required before upload (see `.github/workflows/deploy-web.yml`)                                                                                                                                                       |
| 8   | Main Pi (`update.sh`, from cron)   | GHCR                                                                            | 443 TCP, HTTPS                                                                                   | The backend image, and the pinned PostgreSQL and coturn base images from their registries | TLS. The Pi pulls (cron); GitHub never connects to the Pi.                                                                                                                                                                                                                                                                                                                        |
| 9   | GitHub's runners (Uptime workflow) | `https://securevideocall.com/` and `https://signal.securevideocall.com/healthz` | 443 TCP, HTTPS, GET every 10 minutes                                                             | A public page and the health check                                                        | Read-only requests to public URLs; no personal data; run from outside the home network (`.github/workflows/uptime.yml`, `scripts/check-uptime.sh`)                                                                                                                                                                                                                                |

## Open ports

From the internet, via the router:

- 80 and 443 TCP to the proxy machine (NPM). Its admin port (81) is never forwarded.
- 3478 UDP and TCP, and 49160-49200 UDP, to the coturn container on the Pi.

Never forwarded or reachable from the internet: Daphne's port 8001, PostgreSQL (5432 inside Docker;
a local-only tooling port on the Pi), and NPM's admin interface.

## Picture

```
            Browser A                                   Browser B
              |  \                                       /  |
   (1) HTTPS  |   \ (5) WebRTC, direct if possible      /   | (1) HTTPS
              v    +--------------------------------- +     v
        StackCDN -> static host (Apache)     (4) STUN/TURN if direct fails
                                                      |
   (2) HTTPS/WSS                                      v
        |                                    coturn (main Pi)
        v
  Nginx Proxy Manager (proxy machine) -- (3) plain HTTP, LAN --> Daphne (main Pi) -- (6) --> PostgreSQL

  CI (7) FTPS --> static host        Pi (8) HTTPS --> GHCR        Uptime (9) HTTPS --> both public URLs
```

## Planned changes

Not done yet. Until they are, the flows above are as described and the "not encrypted" notes apply.

- **TLS on the proxy-to-Daphne hop (flow 3):**
  [secure-call-backend#59](https://github.com/The-Secure-Video-Call/secure-call-backend/issues/59).
- **TURN over TLS on port 5349 (flow 4):**
  [secure-call-backend#58](https://github.com/The-Secure-Video-Call/secure-call-backend/issues/58).
- **TLS to PostgreSQL (flow 6):**
  [secure-call-backend#57](https://github.com/The-Secure-Video-Call/secure-call-backend/issues/57).

Keep this file current: any change to a host, port or flow updates it in the same pull request.
