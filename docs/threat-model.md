# Threat model

What secure-call protects, who it defends against, and, just as important, what it does **not**
cover. The design behind the defences is in [PLAN.md](../PLAN.md) section 3 (see 3.3 for what the
servers can see and 3.4 for the web app trust problem); the exact wire format and cryptography is in
[protocol.md](protocol.md). This page does not repeat them.

## What we protect

| Asset       | Where it lives                                      | Goal                                                   |
| ----------- | --------------------------------------------------- | ------------------------------------------------------ |
| Room secret | URL fragment of the call link, then browser memory  | Only the two people with the link ever know it.        |
| `signalKey` | Derived in the browser, non-extractable `CryptoKey` | Never leaves the browser; the server cannot derive it. |
| Media       | WebRTC DTLS-SRTP between the two browsers           | Nobody else can see or hear the call.                  |
| Metadata    | Room ID, IP addresses, timing and size of messages  | Minimised, not hidden. See "Not covered" below.        |

## Who we defend against

### 1. A network attacker

- **Defence:** HTTPS for the app and the signaling WebSocket; signaling payloads are additionally
  AES-256-GCM encrypted with a key the network never sees; media is DTLS-SRTP.
- **Not covered:** an attacker sees that you connect to our servers and, on the media path, IP
  addresses, timing and traffic volume. Blocking or disrupting the connection (denial of service)
  is not prevented.

### 2. A malicious or hacked signaling server

- **Defence:** the server only receives the derived `roomId`, not the secret or `signalKey`. It
  cannot read or change offers, answers or candidates: tampering, replay, reflection and reordering
  all fail authentication, and the call ends with a warning. The safety code shows if the DTLS
  fingerprints were swapped.
- **Not covered:**
  - It sees metadata: the room ID, both IP addresses, when the call starts and ends, and the size
    and timing of the encrypted messages.
  - It can refuse service, drop or delay messages, and end rooms.
  - It can learn that two people met in the same room.
  - A malicious server that is also a compromised static host is the next case.

### 3. A compromised static host

- **Defence:** a strict CSP and security headers are in place (`apps/web/public/.htaccess`) and the
  app has no third-party scripts. SRI and reproducible builds are **not done yet** (PLAN.md 3.4,
  later milestones). Keeping static hosting separate from signaling means
  one compromise does not give the other.
- **Not covered:** whoever controls the static host can serve changed JavaScript that reads the
  secret from the link, the keys or the camera. Nothing in the browser can prevent that today. The
  safety code does not help, because the modified code could show a matching code. Reproducible
  builds only help for people who actually check them.

### 4. A leaked link

- **Defence:** the secret never goes to a server (fragment only), a room holds two people, so a
  third cannot join, and the safety code detects swapped DTLS fingerprints (it cannot tell you
  that the other person is an impostor who holds the link). Rooms expire (10 minutes
  alone, 4 hours in total) and nothing is stored.
- **Not covered:**
  - A link that ends up in chat history, a browser history sync, a screenshot, a shared screen or a
    messaging service's link preview is as good as handing over the call.
  - Someone with the link who joins first is "the other person" until the safety code is compared.
  - A room ID can be reused after expiry: the server keeps no list of old room IDs, so the same link
    works again to start a new room until it is thrown away.

### 5. The other person learning your IP address

- **Defence:** planned for M3: our own TURN server and a "privacy mode" that relays media so the
  other person sees only the relay.
- **Not covered today:** with a direct WebRTC connection, the other person (and the STUN servers,
  which are third-party public ones for now: see `PUBLIC_STUN_ICE_SERVERS`) can learn your IP address.

## Not covered (known limits)

This list is intentionally blunt.

1. **A compromised static host can serve changed JavaScript** (see above). The web app is only as
   trustworthy as what its host sends.
2. **Metadata the server sees:** room ID, both IP addresses, call start and end times, message
   sizes and timing. See PLAN.md section 3.3.
3. **Link leakage:** chat history, screenshots, screen shares and anyone shoulder-surfing the link.
4. **The safety code only helps if people really compare it,** out loud or through another channel
   they trust, and compare all six symbols. If nobody compares, a man in the middle with the link goes
   unnoticed.
5. **Media flows before the safety-code answer, by design.** The call starts as soon as the
   connection is up, so a person in the middle could be heard for the first seconds before anyone
   answers "No".
6. **A changed remote fingerprint is caught only after it is applied.** The app reads the
   fingerprints from the descriptions the connection is already using. If a renegotiation brings a
   different fingerprint, the call ends when the change has been applied, not before.
7. **No timeout between `hello` and the first offer, and no cap on the incoming message queue yet.**
   A peer who holds the link can send a `hello` and then stall, or send many messages, to waste the
   other side's time or memory until the room expires.
8. **A room ID can be reused after expiry** (above). Treat a link as single-use.
9. **Rooms are in memory in one process.** A server restart ends all calls, and the room rules are
   only correct with one server process; going to several processes needs a different room store.
10. **Rate limiting is not implemented on the server yet** (the `rate-limited` error code exists in
    the protocol but is not sent).
11. **Denial of service** in general: a room can be filled by anyone with the link, and the server
    can be flooded.
12. **A compromised device or browser** (malware, a malicious extension) sees everything the
    person sees.
13. **Who you are:** the app does not authenticate people. The safety code proves that you and the
    person you compared with see the same connection, not who that person is.

## Reporting

See [SECURITY.md](../SECURITY.md).
