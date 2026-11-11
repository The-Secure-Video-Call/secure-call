// Tests for check-turn.mjs. Run with: node --test 'scripts/*.test.mjs'
// The STUN and TLS checks run for real against servers on 127.0.0.1; the TLS certificates come
// from a throwaway CA made with the openssl command.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import {
  MAX_MESSAGE_BYTES,
  bindingRequest,
  daysLeft,
  isBindingError,
  isBindingSuccess,
  isEntryPoint,
  main,
  stunOverTls,
  stunOverUdp,
} from './check-turn.mjs';

const TRANSACTION_ID = Buffer.from('000102030405060708090a0b', 'hex');
const MAGIC_COOKIE = Buffer.from('2112a442', 'hex');
const temporaryFolders = [];
after(() => {
  for (const folder of temporaryFolders) rmSync(folder, { recursive: true, force: true });
});
const temporaryFolder = (prefix) => {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  temporaryFolders.push(folder);
  return folder;
};

/** A STUN message: type, then attributes (already padded), with the right length field. */
function stunMessage(type, transactionId, attributes = Buffer.alloc(0)) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(attributes.length, 2);
  return Buffer.concat([header, MAGIC_COOKIE, transactionId, attributes]);
}

// XOR-MAPPED-ADDRESS (type 0x0020, 8 bytes): what coturn really sends back.
const XOR_MAPPED_ADDRESS = Buffer.from('0020000800012e4a21d2a443', 'hex');
const bindingSuccess = (transactionId) => stunMessage(0x0101, transactionId, XOR_MAPPED_ADDRESS);
const idOf = (request) => request.subarray(8, 20);

describe('bindingRequest', () => {
  test('is a 20-byte Binding request with the magic cookie and the transaction ID', () => {
    const message = bindingRequest(TRANSACTION_ID);
    assert.equal(message.length, 20);
    assert.equal(message.readUInt16BE(0), 0x0001);
    assert.equal(message.readUInt16BE(2), 0);
    assert.deepEqual(message.subarray(4, 8), MAGIC_COOKIE);
    assert.deepEqual(message.subarray(8), TRANSACTION_ID);
  });

  test('refuses a transaction ID that is not 12 bytes', () => {
    assert.throws(() => bindingRequest(Buffer.alloc(11)), /12 bytes/);
    assert.throws(() => bindingRequest('000102030405060708090a0b'), /12 bytes/);
  });
});

describe('isBindingSuccess and isBindingError', () => {
  test('accept a Binding success for our transaction, with or without attributes', () => {
    assert.equal(isBindingSuccess(bindingSuccess(TRANSACTION_ID), TRANSACTION_ID), true);
    assert.equal(isBindingSuccess(stunMessage(0x0101, TRANSACTION_ID), TRANSACTION_ID), true);
    assert.equal(isBindingError(stunMessage(0x0111, TRANSACTION_ID), TRANSACTION_ID), true);
  });

  test('reject an answer to another transaction', () => {
    const other = Buffer.alloc(12, 0xff);
    assert.equal(isBindingSuccess(bindingSuccess(other), TRANSACTION_ID), false);
    assert.equal(isBindingError(stunMessage(0x0111, other), TRANSACTION_ID), false);
  });

  test('a Binding error response or a request echoed back is not a success', () => {
    assert.equal(isBindingSuccess(stunMessage(0x0111, TRANSACTION_ID), TRANSACTION_ID), false);
    assert.equal(isBindingSuccess(bindingRequest(TRANSACTION_ID), TRANSACTION_ID), false);
  });

  test('reject a truncated message, extra bytes and a length that is not a multiple of 4', () => {
    const success = bindingSuccess(TRANSACTION_ID);
    assert.equal(isBindingSuccess(success.subarray(0, success.length - 4), TRANSACTION_ID), false);
    assert.equal(isBindingSuccess(success.subarray(0, 19), TRANSACTION_ID), false);
    assert.equal(
      isBindingSuccess(Buffer.concat([success, Buffer.alloc(4)]), TRANSACTION_ID),
      false,
    );
    const oddLength = stunMessage(0x0101, TRANSACTION_ID, Buffer.alloc(6));
    assert.equal(isBindingSuccess(oddLength, TRANSACTION_ID), false);
  });

  test('reject a wrong magic cookie, an oversized message and anything that is not a Buffer', () => {
    const wrongCookie = Buffer.from(bindingSuccess(TRANSACTION_ID));
    wrongCookie.writeUInt32BE(0, 4);
    assert.equal(isBindingSuccess(wrongCookie, TRANSACTION_ID), false);
    const oversized = stunMessage(0x0101, TRANSACTION_ID, Buffer.alloc(MAX_MESSAGE_BYTES));
    assert.equal(isBindingSuccess(oversized, TRANSACTION_ID), false);
    assert.equal(isBindingSuccess(undefined, TRANSACTION_ID), false);
    assert.equal(isBindingSuccess('not a message', TRANSACTION_ID), false);
  });
});

describe('daysLeft', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');

  test('counts whole days, and goes negative once the certificate has expired', () => {
    assert.equal(daysLeft('Dec  2 12:00:00 2026 GMT', now), 21);
    assert.equal(daysLeft('Dec  2 11:59:59 2026 GMT', now), 20);
    assert.equal(daysLeft('Nov 10 12:00:00 2026 GMT', now), -1);
  });

  test('refuses an unreadable date', () => {
    assert.throws(() => daysLeft('not a date', now), /expiry date/);
    assert.throws(() => daysLeft(undefined, now), /expiry date/);
  });
});

describe('isEntryPoint', () => {
  const modulePath = join(import.meta.dirname, 'check-turn.mjs');
  const moduleUrl = pathToFileURL(modulePath).href;

  test('is true for the module itself, also through a symlinked folder', () => {
    assert.equal(isEntryPoint(modulePath, moduleUrl), true);
    const link = join(temporaryFolder('check-turn-link-'), 'scripts');
    symlinkSync(import.meta.dirname, link);
    assert.equal(isEntryPoint(join(link, 'check-turn.mjs'), moduleUrl), true);
  });

  test('is false for another file, a missing file and no argument', () => {
    assert.equal(isEntryPoint(join(import.meta.dirname, 'check-uptime.sh'), moduleUrl), false);
    assert.equal(isEntryPoint(join(import.meta.dirname, 'missing.mjs'), moduleUrl), false);
    assert.equal(isEntryPoint(undefined, moduleUrl), false);
  });
});

/** A UDP server on 127.0.0.1 that answers each request with answer(request), from its own port. */
async function udpServer(answer, replyFrom) {
  const server = dgram.createSocket('udp4');
  server.on('message', (request, remote) => {
    const reply = answer(request);
    if (reply) (replyFrom ?? server).send(reply, remote.port, remote.address);
  });
  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => server.close() };
}

describe('stunOverUdp', () => {
  const check = (port, timeoutMs = 2000) => stunOverUdp({ host: '127.0.0.1', port, timeoutMs });

  test('passes when the server answers with a matching Binding success', async () => {
    const server = await udpServer((request) => bindingSuccess(idOf(request)));
    try {
      assert.deepEqual(await check(server.port), { ok: true });
    } finally {
      server.close();
    }
  });

  test('ignores an answer to another transaction', async () => {
    const server = await udpServer(() => bindingSuccess(Buffer.alloc(12, 0xff)));
    try {
      assert.deepEqual(await check(server.port, 300), { ok: false, reason: 'no answer' });
    } finally {
      server.close();
    }
  });

  test('ignores a matching answer sent from another port', async () => {
    const other = dgram.createSocket('udp4');
    await new Promise((resolve) => other.bind(0, '127.0.0.1', resolve));
    const server = await udpServer((request) => bindingSuccess(idOf(request)), other);
    try {
      assert.deepEqual(await check(server.port, 300), { ok: false, reason: 'no answer' });
    } finally {
      server.close();
      other.close();
    }
  });

  test('reports a Binding error response as such', async () => {
    const server = await udpServer((request) => stunMessage(0x0111, idOf(request)));
    try {
      assert.deepEqual(await check(server.port), {
        ok: false,
        reason: 'Binding error response',
      });
    } finally {
      server.close();
    }
  });

  test('fails when nothing answers, and at once with ECONNREFUSED on a closed port', async () => {
    const silent = await udpServer(() => undefined);
    try {
      assert.deepEqual(await check(silent.port, 300), { ok: false, reason: 'no answer' });
    } finally {
      silent.close();
    }
    const closed = await udpServer(() => undefined);
    closed.close();
    const started = Date.now();
    assert.deepEqual(await check(closed.port, 5000), { ok: false, reason: 'ECONNREFUSED' });
    assert.ok(Date.now() - started < 4000);
  });

  test('fails, without crashing, when the host name does not resolve', async () => {
    // .invalid never resolves (RFC 6761). The lookup error reaches connect's callback.
    const result = await stunOverUdp({ host: 'turn.example.invalid', port: 3478, timeoutMs: 8000 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /^E[A-Z_]+$/);
  });
});

/** A throwaway CA and leaf certificates, made with openssl (OpenSSL or LibreSSL). */
function makeCertificates() {
  const folder = temporaryFolder('check-turn-');
  const run = (...args) => {
    const result = spawnSync('openssl', args, { cwd: folder, encoding: 'utf8' });
    assert.equal(result.status, 0, `openssl ${args.join(' ')}: ${result.stderr}`);
  };
  writeFileSync(
    join(folder, 'openssl.cnf'),
    [
      '[req]',
      'distinguished_name = dn',
      '[dn]',
      '[ca]',
      'basicConstraints = critical,CA:TRUE',
      'keyUsage = critical,keyCertSign,cRLSign',
      '',
    ].join('\n'),
  );
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key');
  run(
    'req',
    '-new',
    '-x509',
    '-config',
    'openssl.cnf',
    '-extensions',
    'ca',
    '-key',
    'ca.key',
    '-subj',
    '/CN=check-turn test CA',
    '-days',
    '3',
    '-out',
    'ca.crt',
  );
  const leaf = (name, days) => {
    writeFileSync(
      join(folder, `${name}.ext`),
      [
        'basicConstraints = critical,CA:FALSE',
        'keyUsage = critical,digitalSignature',
        'extendedKeyUsage = serverAuth',
        `subjectAltName = DNS:${name}`,
        '',
      ].join('\n'),
    );
    run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`);
    run(
      'req',
      '-new',
      '-config',
      'openssl.cnf',
      '-key',
      `${name}.key`,
      '-subj',
      `/CN=${name}`,
      '-out',
      `${name}.csr`,
    );
    run(
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-set_serial',
      '1',
      '-days',
      String(days),
      '-extfile',
      `${name}.ext`,
      '-out',
      `${name}.crt`,
    );
    return {
      key: readFileSync(join(folder, `${name}.key`)),
      cert: readFileSync(join(folder, `${name}.crt`)),
    };
  };
  return {
    ca: readFileSync(join(folder, 'ca.crt')),
    localhost: leaf('localhost', 30),
    otherName: leaf('other.invalid', 30),
  };
}

/** A TLS server on 127.0.0.1 that hands each connection to onConnection(socket). */
async function tlsServer(certificate, onConnection) {
  const server = tls.createServer(certificate, (socket) => {
    socket.on('error', () => {});
    onConnection(socket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Answers the first STUN request on the connection with answer(request), in `pieces` writes. */
const answeringWith =
  (answer, pieces = 1) =>
  (socket) => {
    let received = Buffer.alloc(0);
    let answered = false;
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (answered || received.length < 20) return;
      answered = true;
      const reply = answer(received.subarray(0, 20));
      if (!reply) return;
      const size = Math.ceil(reply.length / pieces);
      for (let start = 0; start < reply.length; start += size) {
        const piece = reply.subarray(start, start + size);
        setTimeout(() => socket.write(piece), start);
      }
    });
  };

describe('stunOverTls', () => {
  let certificates;
  before(() => {
    certificates = makeCertificates();
  });
  const check = (port, options = {}) =>
    stunOverTls({ host: 'localhost', port, timeoutMs: 3000, ca: certificates.ca, ...options });
  const withServer = async (certificate, onConnection, body) => {
    const server = await tlsServer(certificate, onConnection);
    try {
      await body(server.port);
    } finally {
      await server.close();
    }
  };

  test('passes, with the days left, for a trusted certificate and a matching answer', async () => {
    await withServer(
      certificates.localhost,
      answeringWith((request) => bindingSuccess(idOf(request))),
      async (port) => {
        const result = await check(port);
        assert.equal(result.ok, true);
        assert.ok(result.daysLeft >= 29 && result.daysLeft <= 30, String(result.daysLeft));
      },
    );
  });

  test('passes when the answer arrives in several pieces', async () => {
    await withServer(
      certificates.localhost,
      answeringWith((request) => bindingSuccess(idOf(request)), 4),
      async (port) => assert.equal((await check(port)).ok, true),
    );
  });

  test('fails for a certificate made out to another name, and learns no expiry', async () => {
    await withServer(
      certificates.otherName,
      answeringWith((request) => bindingSuccess(idOf(request))),
      async (port) => {
        const result = await check(port);
        assert.deepEqual(
          [result.ok, result.reason, result.daysLeft],
          [false, 'ERR_TLS_CERT_ALTNAME_INVALID', undefined],
        );
      },
    );
  });

  test('fails for a CA the system does not trust, even with NODE_TLS_REJECT_UNAUTHORIZED=0', async () => {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const emitWarning = process.emitWarning;
    process.emitWarning = () => {};
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      await withServer(
        certificates.localhost,
        answeringWith((request) => bindingSuccess(idOf(request))),
        async (port) => {
          const result = await check(port, { ca: undefined });
          assert.equal(result.ok, false);
          assert.equal(result.daysLeft, undefined);
        },
      );
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
      process.emitWarning = emitWarning;
    }
  });

  test('fails on an answer to another transaction or an error response, with the days left', async () => {
    const cases = [
      [() => bindingSuccess(Buffer.alloc(12, 0xff)), 'not a matching Binding success'],
      [(request) => stunMessage(0x0111, idOf(request)), 'Binding error response'],
    ];
    for (const [answer, reason] of cases) {
      await withServer(certificates.localhost, answeringWith(answer), async (port) => {
        const result = await check(port);
        assert.deepEqual([result.ok, result.reason], [false, reason]);
        assert.equal(typeof result.daysLeft, 'number');
      });
    }
  });

  test('fails at once on an oversized answer or a header announcing one', async () => {
    const huge = (request) => {
      const header = stunMessage(0x0101, idOf(request));
      header.writeUInt16BE(0xfffc, 2);
      return header; // the header only: the client must not wait for 65 KB
    };
    for (const answer of [() => Buffer.alloc(MAX_MESSAGE_BYTES + 1, 1), huge]) {
      await withServer(certificates.localhost, answeringWith(answer), async (port) => {
        const started = Date.now();
        const result = await check(port);
        assert.deepEqual([result.ok, result.reason], [false, 'answer too long']);
        assert.ok(Date.now() - started < 2500);
      });
    }
  });

  test('fails on a trailing extra message, a closed connection and silence', async () => {
    await withServer(
      certificates.localhost,
      answeringWith((request) =>
        Buffer.concat([bindingSuccess(idOf(request)), Buffer.alloc(20, 0)]),
      ),
      async (port) => {
        const result = await check(port);
        assert.deepEqual([result.ok, result.reason], [false, 'not a matching Binding success']);
      },
    );
    await withServer(
      certificates.localhost,
      (socket) => socket.on('data', () => socket.end()),
      async (port) => {
        const result = await check(port);
        assert.deepEqual([result.ok, result.reason], [false, 'closed before answering']);
      },
    );
    await withServer(
      certificates.localhost,
      answeringWith(() => undefined),
      async (port) => {
        const result = await check(port, { timeoutMs: 400 });
        assert.deepEqual([result.ok, result.reason], [false, 'no answer']);
        assert.equal(typeof result.daysLeft, 'number');
      },
    );
  });
});

/** A TCP port on 127.0.0.1 that nothing listens on. */
async function closedTcpPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('main', () => {
  let certificates;
  let udp;
  let silentUdp;
  let overTls;
  let wrongAnswerTls;
  before(async () => {
    certificates = makeCertificates();
    udp = await udpServer((request) => bindingSuccess(idOf(request)));
    silentUdp = await udpServer(() => undefined);
    overTls = await tlsServer(
      certificates.localhost,
      answeringWith((request) => bindingSuccess(idOf(request))),
    );
    wrongAnswerTls = await tlsServer(
      certificates.localhost,
      answeringWith(() => bindingSuccess(Buffer.alloc(12, 0xff))),
    );
  });
  after(async () => {
    udp.close();
    silentUdp.close();
    await overTls.close();
    await wrongAnswerTls.close();
  });

  const run = async (options) => {
    const lines = [];
    const failures = await main({
      host: 'localhost',
      udpPort: udp.port,
      tlsPort: overTls.port,
      tries: 2,
      retryMs: 0,
      timeoutMs: 1000,
      ca: certificates.ca,
      log: (line) => lines.push(line),
      ...options,
    });
    return { failures, lines };
  };

  test('prints both targets up and the certificate ok', async () => {
    const { failures, lines } = await run();
    assert.equal(failures, 0);
    assert.deepEqual(lines.slice(0, 2), [
      `up:   turn:localhost:${udp.port} (STUN over UDP)`,
      `up:   turns:localhost:${overTls.port} (STUN over TLS)`,
    ]);
    assert.match(lines[2], /^certificate ok: (29|30) days left$/);
    assert.equal(lines.length, 3);
  });

  test('prints DOWN after the tries', async () => {
    const { failures, lines } = await run({ udpPort: silentUdp.port });
    assert.equal(failures, 1);
    assert.deepEqual(lines.slice(0, 3), [
      `try 1: turn:localhost:${silentUdp.port}: no answer`,
      `try 2: turn:localhost:${silentUdp.port}: no answer`,
      `DOWN: turn:localhost:${silentUdp.port} (STUN over UDP)`,
    ]);
  });

  test('prints CERTIFICATE EXPIRES SOON below the threshold', async () => {
    const { failures, lines } = await run({ minDaysLeft: 31 });
    assert.equal(failures, 0);
    assert.match(lines.at(-1), /^CERTIFICATE EXPIRES SOON: (29|30) days left$/);
  });

  test('prints no certificate line when the handshake failed or the STUN answer did', async () => {
    for (const options of [{ ca: undefined }, { tlsPort: wrongAnswerTls.port }]) {
      const { failures, lines } = await run(options);
      assert.equal(failures, 1);
      assert.match(lines.at(-1), /^DOWN: turns:localhost:\d+ \(STUN over TLS\)$/);
      assert.ok(!lines.some((line) => /certificate/i.test(line)), lines.join('\n'));
    }
  });

  test('never prints an address, even when a connection is refused', async () => {
    const closedTls = await closedTcpPort();
    const closedUdp = await udpServer(() => undefined);
    closedUdp.close();
    const { failures, lines } = await run({ udpPort: closedUdp.port, tlsPort: closedTls });
    assert.equal(failures, 2);
    assert.ok(
      lines.some((line) => line.endsWith(': ECONNREFUSED')),
      lines.join('\n'),
    );
    assert.ok(!lines.some((line) => /127\.0\.0\.1|::1/.test(line)), lines.join('\n'));
  });

  test('prints DOWN for both targets when the host name does not resolve', async () => {
    const { failures, lines } = await run({
      host: 'turn.example.invalid',
      udpPort: 3478,
      tlsPort: 5349,
      timeoutMs: 8000,
    });
    assert.equal(failures, 2);
    assert.deepEqual(
      lines.filter((line) => /^(up: |DOWN:)/.test(line)),
      [
        'DOWN: turn:turn.example.invalid:3478 (STUN over UDP)',
        'DOWN: turns:turn.example.invalid:5349 (STUN over TLS)',
      ],
    );
  });
});
