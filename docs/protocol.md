# Protocol

This document describes everything a second client (for example a Flutter app) needs to
interoperate with the web app. It describes what is implemented, not what is planned. Where the
signaling server's own files are the source of truth, this page links to them instead of copying.

Sources of truth:

- Message shapes and limits: [`signaling/protocol.py`][protocol-py] in secure-call-backend, exported
  as JSON Schema and example messages in its [`protocol/`][protocol-dir] folder (a byte-for-byte copy
  lives in `packages/protocol/contract/`).
- Server behaviour: [`signaling/consumers.py`][consumers-py] and [`signaling/rooms.py`][rooms-py].
- Client behaviour: `apps/web/src/crypto/`, `apps/web/src/rtc/callSession.ts`, `packages/protocol/src/`.

The design reasons are in [PLAN.md](../PLAN.md) section 3; the threats are in
[threat-model.md](threat-model.md).

[protocol-py]: https://github.com/The-Secure-Video-Call/secure-call-backend/blob/main/signaling/protocol.py
[protocol-dir]: https://github.com/The-Secure-Video-Call/secure-call-backend/tree/main/protocol
[consumers-py]: https://github.com/The-Secure-Video-Call/secure-call-backend/blob/main/signaling/consumers.py
[rooms-py]: https://github.com/The-Secure-Video-Call/secure-call-backend/blob/main/signaling/rooms.py

## 1. The flow

One WebSocket per person, text frames only, each frame one JSON message.

```
 first (waiting)                 server                     second (newcomer)
 ───────────────                 ──────                     ─────────────────
 join {roomId}            ──►
                          ◄──  joined {role:"first"}
                                                  ◄──  join {roomId}
                                                  ──►  joined {role:"second"}
                          ◄──  peer-joined
 [new peer connection,                                  [new peer connection,
  impolite, new session ID]                              polite, new session ID]
 signal(hello, seq 0)     ──►  relay  ──►
                          ◄──  relay  ◄──  signal(hello, seq 0)
 (after the peer's hello: add tracks, negotiation starts)
 signal(offer)            ──►  relay  ──►
                          ◄──  relay  ◄──  signal(answer)
 signal(candidate) ...    ◄──► relay ◄──►  signal(candidate) ...
 ═══════════ DTLS-SRTP media directly (or via TURN) ═══════════
 leave                    ──►
                                          ──►  peer-left
```

1. Both derive `roomId` and `signalKey` from the secret in the link (section 4).
2. The client opens the WebSocket and sends `join`. The server answers `joined` with a `role`.
3. If the role is `second`, the server also sends `peer-joined` to the person already waiting.
4. Each side that learns the other is present creates a **new** peer connection, with a new DTLS
   certificate made for it alone and a new random session ID, and sends an encrypted `hello` that
   carries the session ID and a commitment to its DTLS fingerprint (section 5). Nothing else is
   sent until the other side's `hello` has arrived. Then it adds its tracks, which starts the offer/answer exchange
   (perfect negotiation) and ICE candidates, all as encrypted `signal` messages.
5. Either side ends by sending `leave` (or closing the socket). The server sends `peer-left` to the
   other, which closes its peer connection and waits for a new arrival. The encrypted `bye` payload
   kind exists in the schema and is handled on receipt (the peer connection is closed), but the web
   app no longer sends it when hanging up.
6. If the person who stays gets `peer-joined` again (someone new or a rejoin), the flow restarts at
   step 4 with a fresh session.

## 2. Messages

Every message is `{"v": 1, "type": "...", ...}`. Unknown fields, unknown types and wrong types are
rejected (strict). Maximum frame size is 64 KiB (`SIGNALING_MAX_MESSAGE_BYTES`). For exact patterns
read the schema; the limits that matter:

| Direction     | `type`        | Fields                          | Notes                                                                                                    |
| ------------- | ------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| C → S         | `join`        | `roomId`                        | `roomId`: base64url, no padding, 22–43 characters (`^[A-Za-z0-9_-]{22,43}$`).                            |
| C → S / S → C | `signal`      | `payload`, `iv`                 | `payload`: standard base64, 1–64512 characters. `iv`: required, exactly 16 base64 characters (12 bytes). |
| C → S         | `leave`       | none                            | Leaves the room. Error `bad-message` if not in a room.                                                   |
| C → S         | `ping`        | none                            | Answered with `pong`.                                                                                    |
| S → C         | `joined`      | `role`: `"first"` or `"second"` | See section 3.                                                                                           |
| S → C         | `peer-joined` | none                            | Sent to the person already in the room when a second one joins.                                          |
| S → C         | `peer-left`   | none                            | The other person left or disconnected.                                                                   |
| S → C         | `error`       | `code`                          | See below.                                                                                               |
| S → C         | `pong`        | none                            | Reply to `ping`.                                                                                         |

The server never decodes, parses or logs `payload`. It relays the `signal` text to the other member
exactly as received, so `iv` must be present or the message is rejected at the server (`required iv`).

### Error codes

`error.code` is one of: `room-full`, `room-expired`, `rate-limited`, `bad-message`,
`unsupported-type`.

| Code               | When the server sends it                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `room-full`        | A third person tries to join. The server then closes with 1000.                                                                                                                                                    |
| `room-expired`     | The room hit a time limit (section 8). The server then closes with 1000.                                                                                                                                           |
| `bad-message`      | `join` while already in a room, or `signal` / `leave` while not in one. Connection stays open.                                                                                                                     |
| `rate-limited`     | Too many open connections for one client or in total (sent right after accept), a `join` over the join limit, or any message over the per-connection message budget. The server then closes with 4029 (section 7). |
| `unsupported-type` | Part of the schema. The current server never sends it; a client must still handle it (the web app ends the call).                                                                                                  |

A message that fails schema validation is not answered with an error: the connection is closed
(section 7).

## 3. What `role` means

- `first`: the room was empty when you joined.
- `second`: someone was already there. That person has been sent `peer-joined`.

In perfect negotiation, the newcomer (`second`) is the **polite** side. Whoever **receives**
`peer-joined` is **impolite**. The role is used exactly once, to decide this when the connection is
created, and is never used again. It plays no part in encryption: the AAD role byte is derived from
the session IDs (section 5). After a rejoin both people can hold `second` (for example the
`first` person leaves, the remaining person still holds the `second` they got earlier, and the
newcomer is also told `second`). That is harmless because a stored role is never looked at again
(see secure-call-backend#22).

## 4. Key derivation

The room secret is 32 random bytes from `crypto.getRandomValues`. It is placed in the URL fragment
as base64url without padding (43 characters): `https://<host>/#<secret>`. It is never sent anywhere.
A fragment that does not decode to exactly 32 bytes is rejected.

Both keys use HKDF-SHA256 (RFC 5869) with the secret as input key material and an **empty salt**
(zero bytes). Only the `info` string and output length differ:

| Output      | `info` (ASCII) | Length   | Use                                                                                    |
| ----------- | -------------- | -------- | -------------------------------------------------------------------------------------- |
| `roomId`    | `room`         | 16 bytes | Encoded as base64url without padding (22 characters). Sent to the server.              |
| `signalKey` | `signal`       | 32 bytes | AES-256-GCM key. Never sent. Import as a non-extractable key for encrypt/decrypt only. |

Sources: `crypto/hkdf.ts`, `crypto/roomId.ts`, `crypto/signalKey.ts`, `crypto/secret.ts`.

## 5. Encryption of `signal` messages

### Payload

The plaintext is UTF-8 JSON, one of (strict, no extra fields; see `packages/protocol/src/signalPayload.ts`):

```
{"kind":"hello","data":{"sessionId":"<22 base64url chars>","fingerprintCommitment":"<43 base64url chars>"},"seq":N}
{"kind":"offer","data":{"type":"offer","sdp":"..."},"seq":N}
{"kind":"answer","data":{"type":"answer","sdp":"..."},"seq":N}
{"kind":"candidate","data":{"candidate":"...","sdpMid":...,"sdpMLineIndex":...,"usernameFragment":...},"seq":N}
{"kind":"bye","data":null,"seq":N}
```

`seq` is an integer from 0 to 2^53 − 1. SDP and candidate text are limited to 40000 and 2000
characters. `sdpMid` and `usernameFragment` have a limit of 256 characters (or null / absent);
`sdpMLineIndex` is an integer from 0 to 65535 (or null / absent).

### Cipher

- AES-256-GCM, 128-bit tag, key = `signalKey`.
- A fresh random 12-byte IV for **every** message (`crypto.getRandomValues`), never a counter.
- `signal.payload` = standard base64 of `ciphertext ‖ tag`. `signal.iv` = standard base64 of the IV.
- Encrypted size must keep `payload` within 64512 characters; otherwise the message is not sent.
- On receipt, anything wrong (missing or wrong-length `iv`, bad base64, authentication failure,
  invalid JSON, schema mismatch, `seq` different from the expected one) is treated the same: the
  call ends.

### AAD (additional authenticated data)

Fixed length: **62 bytes**.

| Offset | Size | Field                                                                                                                                                                       |
| ------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | 21   | ASCII `secure-call/signal/v1` (a new layout needs a new label)                                                                                                              |
| 21     | 1    | Sender role: `0x00` hello; `0x01` sender's session ID is the smaller; `0x02` sender's session ID is the larger (compared as 16 unsigned bytes, first byte most significant) |
| 22     | 8    | `seq`, unsigned 64-bit, big-endian                                                                                                                                          |
| 30     | 16   | Sender's session ID (16 zero bytes in a `hello`)                                                                                                                            |
| 46     | 16   | Receiver's session ID, the one learned from the receiver's `hello` (16 zero bytes in a `hello`)                                                                             |

### Session IDs and `seq` rules

- Each time a peer connection is created, the side picks a new random 16-byte session ID and keeps
  it for that connection only.
- The first message is the `hello` with `seq` 0 carrying the session ID as base64url (22 characters,
  canonical encoding). Its AAD uses role `0x00` and all-zero IDs because neither ID is known yet.
- No other message is sent until the peer's `hello` is accepted. The `hello` is accepted only if it
  is the first message, decodes to exactly 16 bytes in canonical form, and differs from our own ID
  (equal means our own message was reflected back).
- After that, every message uses the AAD with both session IDs and the role byte computed from them.
  The two sides therefore always have opposite roles, and a reflected message fails.
- `seq` starts at 0 (the `hello`) and each side counts its own outgoing messages. The receiver
  expects exactly the next number; a replayed, skipped or reordered message fails authentication
  because `seq` is in the AAD and is also checked inside the plaintext. The number is taken only when
  a message was actually sent.
- A second `hello` in a session ends the call. A signal arriving while no peer connection exists
  ends the call, with one exception: while the certificate for our new connection is being made,
  the other side's `hello` (and nothing more: one message) waits and is handled once the connection
  exists.
- Messages recorded in an earlier session fail because the receiver's session ID is new.

### Fingerprint commitment

So that nobody in the middle can choose his certificates after seeing the real ones (and search for
two that give both sides the same safety code), each side commits to its DTLS fingerprint before
any SDP is sent:

- **A fresh certificate per peer connection:** ECDSA P-256 from
  `RTCPeerConnection.generateCertificate()`, passed as the connection's only certificate, made in
  memory, used once and never stored. Its fingerprint is read from the `a=fingerprint:` line of an
  offer from a throwaway local peer connection with the same certificate (no ICE servers, no
  description set, closed at once), because `RTCCertificate.getFingerprints()` is not in every
  browser.
- **The commitment** is SHA-256 over the UTF-8 bytes of `secure-call/fp-commit/v1`, a `\n` (0x0A)
  and the normalised fingerprint (section 6, step 2), as unpadded base64url: 43 characters, 32
  bytes. No nonce is needed: the fingerprint of a fresh key cannot be guessed.
- **It is required in the `hello`.** The `hello` is accepted only if the commitment decodes to
  exactly 32 bytes in canonical form and differs from our own (equal means our own message was
  reflected back).
- **Every offer and answer of the other side** must carry exactly one fingerprint (section 6, step
  1), whose commitment equals the one in its `hello`. It is checked before the description is
  applied; any mismatch ends the call. Renegotiations are checked the same way.
- **The order does the rest:** no SDP leaves before the other side's `hello` is accepted, so each
  side has fixed its certificate before it can see the other's fingerprint.

### What ends the call

The call ends (peer connection and socket closed, warning shown) when a received `signal` fails any
check above (including an offer or answer whose fingerprint is not the committed one), when our
own `hello`, offer or answer cannot be sent (or the certificate for the connection cannot be made), when the server sends an invalid
message, `room-full`, `room-expired`, `rate-limited`, `bad-message` or `unsupported-type`, when
the socket is lost, or when the people hang up. A failed candidate send is only reported.

It also ends (as `message-verification-failed`) when the peer says `hello` but no offer **or**
answer follows within 10 seconds (the side that did not start the negotiation may receive only an
answer), and when more than 64 received messages are waiting to be handled. The 10 second timer
starts when the `hello` is accepted and stops when an offer or answer passes the fingerprint check,
or when the connection closes or the call ends. It does not wait for the connection to come up:
there is no connect timeout yet.

## 6. Safety code

After the peer connection is up, both sides compute the same six symbols from the two DTLS
fingerprints and ask each other to compare them. Both fingerprints were committed in the `hello`s
(section 5), so someone in the middle had to choose his certificates blind: his chance of matching
codes is 2^-36 per attempt, and every failed attempt is a call where the codes differ. The code is
a short authentication string by design; 36 bits is less than the 128 bits ASVS V11.4.3 asks of
a hash, which is accepted because of the commitment.

1. Read the fingerprint from the **current** local and remote descriptions (`a=fingerprint:` lines,
   session or media level). Zero fingerprints, two different ones on one side, or a malformed
   line is an error (no code is shown).
2. Normalise: `<hash name lowercase> <HEX UPPERCASE WITH COLONS>`, for example `sha-256 00:01:...`.
   Accepted hashes: `sha-256` (32 bytes), `sha-384` (48), `sha-512` (64); `sha-1` is rejected. The
   value must be exactly `<hash> <hex>` with the right number of two-digit hex bytes.
3. Sort the two normalised strings (plain string comparison) and join them with a single `\n`
   (0x0A).
4. SHA-256 of the UTF-8 bytes of that string.
5. Take the first 36 bits (first 5 bytes; the last 4 bits of byte 5 are dropped) and split them,
   big-endian, into six 6-bit numbers (0–63).
6. Show each number as the emoji at that index in the list below, or in the digits form: each
   number as two decimal digits (`00`–`63`).

The order of the list is part of the protocol.

| Index | Emoji | Name    | Index | Emoji | Name      | Index | Emoji | Name       | Index | Emoji | Name        |
| ----- | ----- | ------- | ----- | ----- | --------- | ----- | ----- | ---------- | ----- | ----- | ----------- |
| 00    | 🐶    | dog     | 16    | 🐧    | penguin   | 32    | 🍎    | apple      | 48    | 🌻    | sunflower   |
| 01    | 🐱    | cat     | 17    | 🦆    | duck      | 33    | 🍌    | banana     | 49    | 🌈    | rainbow     |
| 02    | 🐭    | mouse   | 18    | 🐢    | turtle    | 34    | 🍇    | grapes     | 50    | ⭐    | star        |
| 03    | 🐹    | hamster | 19    | 🐙    | octopus   | 35    | 🍓    | strawberry | 51    | 🔥    | fire        |
| 04    | 🐰    | rabbit  | 20    | 🐬    | dolphin   | 36    | 🍒    | cherries   | 52    | 🌙    | moon        |
| 05    | 🦊    | fox     | 21    | 🐳    | whale     | 37    | 🍋    | lemon      | 53    | ⚽    | soccer ball |
| 06    | 🐻    | bear    | 22    | 🦋    | butterfly | 38    | 🍉    | watermelon | 54    | 🎸    | guitar      |
| 07    | 🐼    | panda   | 23    | 🐝    | bee       | 39    | 🍕    | pizza      | 55    | 🚗    | car         |
| 08    | 🐨    | koala   | 24    | 🐞    | ladybug   | 40    | 🍔    | hamburger  | 56    | 🚀    | rocket      |
| 09    | 🐯    | tiger   | 25    | 🐌    | snail     | 41    | 🍩    | doughnut   | 57    | ⚓    | anchor      |
| 10    | 🦁    | lion    | 26    | 🦉    | owl       | 42    | 🍪    | cookie     | 58    | 🔑    | key         |
| 11    | 🐮    | cow     | 27    | 🐘    | elephant  | 43    | 🌽    | corn       | 59    | 🔔    | bell        |
| 12    | 🐷    | pig     | 28    | 🦒    | giraffe   | 44    | 🥕    | carrot     | 60    | 🎈    | balloon     |
| 13    | 🐸    | frog    | 29    | 🐴    | horse     | 45    | 🍄    | mushroom   | 61    | 🎁    | gift        |
| 14    | 🐵    | monkey  | 30    | 🦄    | unicorn   | 46    | 🌵    | cactus     | 62    | 👑    | crown       |
| 15    | 🐔    | chicken | 31    | 🐊    | crocodile | 47    | 🌲    | tree       | 63    | 💎    | gem         |

Answering **No** ends the call and shows a warning. Rules for what the app does with the code
(`decideSafetyCodeUpdate`): before the person presses
Yes, the code is recomputed from the current descriptions whenever negotiation settles, so the
shown code is never stale. After Yes, the fingerprint pair must stay exactly the verified one; any
change ends the call. A new peer connection needs a new verification.

## 7. WebSocket close codes

| Code | Meaning          | Sent by server when                                                                                                                                                                                             |
| ---- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1000 | Normal close     | After `room-full` or `room-expired`; the client uses it when it hangs up.                                                                                                                                       |
| 4003 | Unsupported data | A binary frame was received.                                                                                                                                                                                    |
| 4008 | Policy violation | A text frame is not a valid client message (bad JSON, unknown type or field, wrong type), or no `join` arrived within 10 seconds of connecting. The web client uses it when the server sends something invalid. |
| 4009 | Message too big  | A text frame is larger than 64 KiB.                                                                                                                                                                             |
| 4029 | Rate limited     | Too many joins, messages or open connections. An `error` with code `rate-limited` is sent first.                                                                                                                |

The numbers 4003, 4008, 4009 and 4029 carry the RFC 6455 meanings of 1003, 1008 and 1009 (and
HTTP 429 for 4029) in their last digits. They are in the 4000 range because browsers only allow an application to close with 1000 or
3000–4999 (anything else throws `InvalidAccessError`), and Daphne (Autobahn) only lets an application
send 1000 or 3000–4999 (anything else raises and skips `disconnect`). On any of these closes the
server removes the connection from its room first, so the other person gets `peer-left`.

## 8. Limits and versioning

- Two people per room. A third join gets `room-full`.
- A room expires after **10 minutes** with exactly one person waiting alone (the clock restarts
  whenever the room goes back to one person), or **4 hours** after
  it was created, whichever comes first. Members get `room-expired` and are closed with 1000.
  Joining the same room ID afterwards creates a new room.
- The server keeps rooms in memory only; nothing is written to disk.
- Maximum frame 64 KiB; `payload` at most 64512 characters.
- Versioning: every message has `"v": 1`. Other values are rejected. Any breaking change to
  message shapes bumps `v`; any change to the encryption layout (AAD, key derivation) uses a new
  AAD label instead of `.../v1`.
- The encrypted payload (section 5) is not seen by the server and changes with the web app: both
  people run the same build, served by the same host. A change to its shape (like the required
  `fingerprintCommitment` in the `hello`) fails closed between an old and a new build: someone who
  kept a tab open from before a deploy sees "The connection could not be verified" until one of
  them reloads. That is safe (nothing falls back to the old shape), but it is a false alarm, so such changes
  are rare.

## 9. Test vectors

Computed outside the application code and checked in the unit tests. A new client should reproduce them.

### Key derivation (`crypto/signalKey.test.ts`)

Secret: 32 bytes of `0x01`. HKDF-SHA256, empty salt.

- `signalKey` (`info` = `signal`, 32 bytes):
  `0c93a41be59992a0c3bdd12a3dda9b29c3dca5aa380d10ee809c9d022c5ec281`
- `roomId` bytes (`info` = `room`, 16 bytes): `b14b4b0fa71ea2080d5351d8dd211054`
- `roomId` (base64url): `sUtLD6ceoggNU1HY3SEQVA`

### Safety code (`crypto/safetyCode.test.ts`)

Inputs: two `sha-256` fingerprints.

- First: bytes `00 01 02 ... 1F` (`00:01:02:...:1F`, 32 bytes, counting up from 0x00).
- Second: bytes `FF FE FD ... E0` (`FF:FE:FD:...:E0`, 32 bytes, counting down from 0xFF).

Hash input (after sorting, joined with `\n`):
`sha-256 00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F`
`\n`
`sha-256 FF:FE:FD:FC:FB:FA:F9:F8:F7:F6:F5:F4:F3:F2:F1:F0:EF:EE:ED:EC:EB:EA:E9:E8:E7:E6:E5:E4:E3:E2:E1:E0`

SHA-256 starts with `9f0f827a16`. First 36 bits as six 6-bit numbers:
`[39, 48, 62, 2, 30, 33]`. Digits form: `39 48 62 02 30 33`. Emoji: 🍕 🌻 👑 🐭 🦄 🍌.
The result is the same if local and remote are swapped.
