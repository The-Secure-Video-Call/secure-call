// Checks that coturn answers STUN Binding requests over UDP on 3478 and over TLS on 5349, and how
// many days the certificate served on 5349 has left. Run by scripts/check-uptime.sh, which reads
// the lines this prints:
//   up:   <target> (<how>)                       the check passed
//   DOWN: <target> (<how>)                       three tries failed
//   certificate ok: <n> days left                the 5349 certificate has MIN_DAYS_LEFT or more
//   CERTIFICATE EXPIRES SOON: <n> days left      fewer than MIN_DAYS_LEFT
// No certificate line means the TLS handshake never completed, so its expiry is unknown.
//
// It prints only our host name, ports and error codes, never what the server sent: a STUN
// response carries the runner's own public address. Binding requests need no TURN credentials.
// The certificate is checked by Node's default TLS verification (trusted chain, host name).
//
// Optional: UPTIME_RETRY_SECONDS (default 30), as in check-uptime.sh.
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

export const TURN_HOST = 'turn.securevideocall.com';
export const MIN_DAYS_LEFT = 21;
const STUN_MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const HEADER_LENGTH = 20;
// coturn's Binding success is well under 100 bytes; anything longer is not one.
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

/** Whether `message` is exactly one Binding success response to the request with `transactionId`. */
export function isBindingSuccess(message, transactionId) {
  if (!Buffer.isBuffer(message) || message.length < HEADER_LENGTH) return false;
  if (message.length > MAX_MESSAGE_BYTES) return false;
  const attributesLength = message.readUInt16BE(2);
  return (
    message.readUInt16BE(0) === BINDING_SUCCESS &&
    attributesLength % 4 === 0 &&
    message.length === HEADER_LENGTH + attributesLength &&
    message.readUInt32BE(4) === STUN_MAGIC_COOKIE &&
    message.subarray(8, HEADER_LENGTH).equals(transactionId)
  );
}

/** Whole days from `nowMs` until the certificate's `valid_to`; negative once it has expired. */
export function daysLeft(validTo, nowMs) {
  const expiresMs = Date.parse(validTo);
  if (Number.isNaN(expiresMs)) throw new Error('The certificate has no readable expiry date.');
  return Math.floor((expiresMs - nowMs) / DAY_MS);
}

function errorReason(error) {
  return typeof error?.code === 'string' ? error.code : 'error';
}

/** One STUN Binding request over UDP. Resolves to {ok, reason}. */
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
    // Other datagrams (late answers to an earlier try use another socket) are ignored.
    socket.on('message', (message) => {
      if (isBindingSuccess(message, transactionId)) finish({ ok: true });
    });
    socket.send(bindingRequest(transactionId), port, host, (error) => {
      if (error) finish({ ok: false, reason: errorReason(error) });
    });
  });
}

/**
 * One STUN Binding request over TLS. Resolves to {ok, reason, daysLeft}; daysLeft is set
 * whenever the handshake completed, even if the STUN answer then failed. `ca` replaces the
 * system's trusted certificates and exists for the tests only; the check never passes it.
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
    // Reached only after Node verified the chain and the host name (rejectUnauthorized).
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
      if (received.length < messageLength) return;
      const answer = received.subarray(0, messageLength);
      finish(
        isBindingSuccess(answer, transactionId) && received.length === messageLength
          ? { ok: true }
          : { ok: false, reason: 'not a matching Binding success' },
      );
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

/** Runs both checks and prints the lines described at the top. Returns the number of failures. */
export async function main({
  host = TURN_HOST,
  udpPort = 3478,
  tlsPort = 5349,
  tries = 3,
  retryMs = Number(process.env.UPTIME_RETRY_SECONDS ?? 30) * 1000,
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
  let lastDaysLeft;
  const overTls = await withTries(
    tries,
    retryMs,
    async () => {
      const result = await stunOverTls({ host, port: tlsPort, timeoutMs, nowMs, ca });
      if (result.daysLeft !== undefined) lastDaysLeft = result.daysLeft;
      return result;
    },
    log,
    tlsTarget,
  );
  log(`${overTls.ok ? 'up:  ' : 'DOWN:'} ${tlsTarget} (STUN over TLS)`);
  if (!overTls.ok) failures += 1;

  if (lastDaysLeft !== undefined) {
    log(
      lastDaysLeft >= minDaysLeft
        ? `certificate ok: ${lastDaysLeft} days left`
        : `CERTIFICATE EXPIRES SOON: ${lastDaysLeft} days left`,
    );
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Failures are reported in the printed lines; the exit code is non-zero only if the check
  // itself broke, so check-uptime.sh can tell "TURN is down" from "the check did not run".
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(`check-turn.mjs failed: ${error instanceof Error ? error.message : 'error'}`);
      process.exit(2);
    },
  );
}
