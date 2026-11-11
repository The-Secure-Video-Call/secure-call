// Checks that coturn answers STUN Binding requests over UDP on 3478 and over TLS on 5349, and how
// many days the certificate served on 5349 has left. Run by scripts/check-uptime.sh, which reads
// the lines this prints:
//   up:   <target> (<how>)                       the check passed
//   DOWN: <target> (<how>)                       three tries failed
//   certificate ok: <n> days left                the 5349 certificate has MIN_DAYS_LEFT or more
//   CERTIFICATE EXPIRES SOON: <n> days left      fewer than MIN_DAYS_LEFT
// Exactly one up/DOWN line per target, always. The certificate line comes only from a try whose
// STUN answer over TLS also passed (so it is coturn's certificate); without one, its expiry is
// unknown and no certificate line is printed.
//
// It prints only our host name, ports and error codes, never what a server sent (a STUN answer
// carries the runner's own public address) and never Node's error messages (which name the
// resolved address). Binding requests need no TURN credentials. The certificate's chain and host
// name are checked by Node's TLS verification, which this sets explicitly, so an environment
// variable such as NODE_TLS_REJECT_UNAUTHORIZED cannot turn it off.
//
// Optional: UPTIME_RETRY_SECONDS (default 30), as in check-uptime.sh.
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { realpathSync } from 'node:fs';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

export const TURN_HOST = 'turn.securevideocall.com';
export const MIN_DAYS_LEFT = 21;
const STUN_MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const BINDING_ERROR = 0x0111;
const HEADER_LENGTH = 20;
// coturn's Binding answers are well under 100 bytes; anything longer is not one.
export const MAX_MESSAGE_BYTES = 512;
const DAY_MS = 86_400_000;

/** A STUN Binding request (RFC 8489 section 5) with no attributes. */
export function bindingRequest(transactionId) {
  if (!Buffer.isBuffer(transactionId) || transactionId.length !== 12) {
    throw new Error('A STUN transaction ID is 12 bytes.');
  }
  const message = Buffer.alloc(HEADER_LENGTH);
  message.writeUInt16BE(BINDING_REQUEST, 0);
  message.writeUInt16BE(0, 2);
  message.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(message, 8);
  return message;
}

/** Whether `message` is exactly one well-formed STUN message of `type` for `transactionId`. */
function isAnswerOfType(message, transactionId, type) {
  if (!Buffer.isBuffer(message) || message.length < HEADER_LENGTH) return false;
  if (message.length > MAX_MESSAGE_BYTES) return false;
  const attributesLength = message.readUInt16BE(2);
  return (
    message.readUInt16BE(0) === type &&
    attributesLength % 4 === 0 &&
    message.length === HEADER_LENGTH + attributesLength &&
    message.readUInt32BE(4) === STUN_MAGIC_COOKIE &&
    message.subarray(8, HEADER_LENGTH).equals(transactionId)
  );
}

/** Whether `message` is exactly one Binding success response to the request with `transactionId`. */
export function isBindingSuccess(message, transactionId) {
  return isAnswerOfType(message, transactionId, BINDING_SUCCESS);
}

/** Whether `message` is a Binding error response to our request (coturn up, but refusing). */
export function isBindingError(message, transactionId) {
  return isAnswerOfType(message, transactionId, BINDING_ERROR);
}

/** Whole days from `nowMs` until the certificate's `valid_to`; negative once it has expired. */
export function daysLeft(validTo, nowMs) {
  const expiresMs = Date.parse(validTo);
  if (Number.isNaN(expiresMs)) throw new Error('The certificate has no readable expiry date.');
  return Math.floor((expiresMs - nowMs) / DAY_MS);
}

/** Only Node's error code (a fixed set of names), never its message, which names addresses. */
function errorReason(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'error';
}

/**
 * One STUN Binding request over UDP. Resolves to {ok, reason}. The socket is connected to the
 * server, so the kernel drops datagrams from any other address or port, and a closed port fails
 * at once (ECONNREFUSED) instead of timing out.
 */
export function stunOverUdp({ host, port, timeoutMs, transactionId = randomBytes(12) }) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'no answer' }), timeoutMs);
    socket.on('error', (error) => finish({ ok: false, reason: errorReason(error) }));
    socket.on('message', (message) => {
      if (isBindingSuccess(message, transactionId)) finish({ ok: true });
      else if (isBindingError(message, transactionId)) {
        finish({ ok: false, reason: 'Binding error response' });
      }
      // Anything else is ignored; the timer decides.
    });
    // A failed name lookup comes to this callback as its argument, not as an 'error' event.
    socket.connect(port, host, (connectError) => {
      if (connectError) {
        finish({ ok: false, reason: errorReason(connectError) });
        return;
      }
      socket.send(bindingRequest(transactionId), (error) => {
        if (error) finish({ ok: false, reason: errorReason(error) });
      });
    });
  });
}

/**
 * One STUN Binding request over TLS. Resolves to {ok, reason, daysLeft}; daysLeft is set
 * whenever the handshake completed, even if the STUN answer then failed. `ca` replaces the
 * system's trusted certificates and exists for the tests only: the program never passes it.
 */
export function stunOverTls({
  host,
  port,
  timeoutMs,
  transactionId = randomBytes(12),
  nowMs = Date.now(),
  ca,
}) {
  return new Promise((resolve) => {
    let done = false;
    let certificateDaysLeft;
    let received = Buffer.alloc(0);
    const socket = tls.connect({
      host,
      port,
      servername: host,
      minVersion: 'TLSv1.2',
      // Explicit, so NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment cannot turn these off.
      rejectUnauthorized: true,
      checkServerIdentity: tls.checkServerIdentity,
      ...(ca === undefined ? {} : { ca }),
    });
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...result, daysLeft: certificateDaysLeft });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'no answer' }), timeoutMs);
    // Reached only after Node verified the chain and the host name.
    socket.on('secureConnect', () => {
      try {
        certificateDaysLeft = daysLeft(socket.getPeerCertificate().valid_to, nowMs);
      } catch {
        finish({ ok: false, reason: 'unreadable certificate' });
        return;
      }
      socket.write(bindingRequest(transactionId));
    });
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_MESSAGE_BYTES) {
        finish({ ok: false, reason: 'answer too long' });
        return;
      }
      if (received.length < HEADER_LENGTH) return;
      const messageLength = HEADER_LENGTH + received.readUInt16BE(2);
      if (messageLength > MAX_MESSAGE_BYTES) {
        finish({ ok: false, reason: 'answer too long' });
        return;
      }
      if (received.length < messageLength) return;
      const answer = received.subarray(0, messageLength);
      if (received.length !== messageLength) {
        finish({ ok: false, reason: 'not a matching Binding success' });
      } else if (isBindingSuccess(answer, transactionId)) {
        finish({ ok: true });
      } else if (isBindingError(answer, transactionId)) {
        finish({ ok: false, reason: 'Binding error response' });
      } else {
        finish({ ok: false, reason: 'not a matching Binding success' });
      }
    });
    socket.on('error', (error) => finish({ ok: false, reason: errorReason(error) }));
    socket.on('close', () => finish({ ok: false, reason: 'closed before answering' }));
  });
}

async function withTries(tries, retryMs, attempt, log, label) {
  let result;
  for (let tryNumber = 1; tryNumber <= tries; tryNumber += 1) {
    result = await attempt();
    if (result.ok) return result;
    log(`try ${tryNumber}: ${label}: ${result.reason}`);
    if (tryNumber < tries) await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  return result;
}

function retryMsFromEnvironment() {
  const seconds = Number(process.env.UPTIME_RETRY_SECONDS || 30);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 30_000;
}

/** Runs both checks and prints the lines described at the top. Returns the number of failures. */
export async function main({
  host = TURN_HOST,
  udpPort = 3478,
  tlsPort = 5349,
  tries = 3,
  retryMs = retryMsFromEnvironment(),
  timeoutMs = 10_000,
  minDaysLeft = MIN_DAYS_LEFT,
  nowMs,
  ca,
  log = console.log,
} = {}) {
  let failures = 0;

  const udpTarget = `turn:${host}:${udpPort}`;
  const udp = await withTries(
    tries,
    retryMs,
    () => stunOverUdp({ host, port: udpPort, timeoutMs }),
    log,
    udpTarget,
  );
  log(`${udp.ok ? 'up:  ' : 'DOWN:'} ${udpTarget} (STUN over UDP)`);
  if (!udp.ok) failures += 1;

  const tlsTarget = `turns:${host}:${tlsPort}`;
  const overTls = await withTries(
    tries,
    retryMs,
    () => stunOverTls({ host, port: tlsPort, timeoutMs, nowMs, ca }),
    log,
    tlsTarget,
  );
  log(`${overTls.ok ? 'up:  ' : 'DOWN:'} ${tlsTarget} (STUN over TLS)`);
  if (!overTls.ok) failures += 1;

  // withTries returns the passing try, so this is coturn's own certificate.
  if (overTls.ok && overTls.daysLeft !== undefined) {
    log(
      overTls.daysLeft >= minDaysLeft
        ? `certificate ok: ${overTls.daysLeft} days left`
        : `CERTIFICATE EXPIRES SOON: ${overTls.daysLeft} days left`,
    );
  }
  return failures;
}

/** Whether this module is the program node was started with, also through a symlinked path. */
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  // Failures are reported in the printed lines; the exit code is non-zero only if the check
  // itself broke, so check-uptime.sh can tell "TURN is down" from "the check did not run".
  // A crash prints a fixed line, never Node's stack trace (its messages name addresses).
  process.on('uncaughtException', () => {
    console.error('check-turn.mjs crashed.');
    process.exit(2);
  });
  main().then(
    () => process.exit(0),
    () => {
      console.error('check-turn.mjs failed before it finished.');
      process.exit(2);
    },
  );
}
