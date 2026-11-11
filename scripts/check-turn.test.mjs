// Tests for check-turn.mjs. Run with: node --test 'scripts/*.test.mjs'
// The STUN and TLS checks run for real against servers on 127.0.0.1; the TLS certificates come
// from a throwaway CA made with the openssl command.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { after, before, describe, test } from 'node:test';
import {
  MAX_MESSAGE_BYTES,
  bindingRequest,
  daysLeft,
  isBindingSuccess,
  main,
  stunOverTls,
  stunOverUdp,
} from './check-turn.mjs';

const TRANSACTION_ID = Buffer.from('000102030405060708090a0b', 'hex');
const MAGIC_COOKIE = Buffer.from('2112a442', 'hex');

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

describe('isBindingSuccess', () => {
  test('accepts a Binding success for our transaction, with or without attributes', () => {
    assert.equal(isBindingSuccess(bindingSuccess(TRANSACTION_ID), TRANSACTION_ID), true);
    assert.equal(isBindingSuccess(stunMessage(0x0101, TRANSACTION_ID), TRANSACTION_ID), true);
  });

  test('rejects an answer to another transaction', () => {
    const other = Buffer.from('ffffffffffffffffffffffff', 'hex');
    assert.equal(isBindingSuccess(bindingSuccess(other), TRANSACTION_ID), false);
  });

  test('rejects a Binding error response and a request echoed back', () => {
    assert.equal(isBindingSuccess(stunMessage(0x0111, TRANSACTION_ID), TRANSACTION_ID), false);
    assert.equal(isBindingSuccess(bindingRequest(TRANSACTION_ID), TRANSACTION_ID), false);
  });

  test('rejects a truncated message, extra bytes and a length that is not a multiple of 4', () => {
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

  test('rejects a wrong magic cookie, an oversized message and anything that is not a Buffer', () => {
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

/** A UDP server on 127.0.0.1 that answers each request with answer(request). */
async function udpServer(answer) {
  const server = dgram.createSocket('udp4');
  server.on('message', (request, remote) => {
    const reply = answer(request);
    if (reply) server.send(reply, remote.port, remote.address);
  });
  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => server.close() };
}

describe('stunOverUdp', () => {
  test('passes when the server answers with a matching Binding success', async () => {
    const server = await udpServer((request) => bindingSuccess(request.subarray(8, 20)));
    try {
      const result = await stunOverUdp({ host: '127.0.0.1', port: server.port, timeoutMs: 2000 });
      assert.deepEqual(result, { ok: true });
    } finally {
      server.close();
    }
  });

  test('fails on an answer to another transaction or an error response', async () => {
    for (const answer of [
      () => bindingSuccess(Buffer.alloc(12, 0xff)),
      (request) => stunMessage(0x0111, request.subarray(8, 20)),
    ]) {
      const server = await udpServer(answer);
      try {
        const result = await stunOverUdp({ host: '127.0.0.1', port: server.port, timeoutMs: 300 });
        assert.deepEqual(result, { ok: false, reason: 'no answer' });
      } finally {
        server.close();
      }
    }
  });

  test('fails when nothing answers', async () => {
    const server = await udpServer(() => undefined);
    try {
      const result = await stunOverUdp({ host: '127.0.0.1', port: server.port, timeoutMs: 300 });
      assert.equal(result.ok, false);
    } finally {
      server.close();
    }
  });
});

/** A throwaway CA and leaf certificates, made with openssl (OpenSSL or LibreSSL). */
function makeCertificates() {
  const folder = mkdtempSync(join(tmpdir(), 'check-turn-'));
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
  const server = tls.createServer(certificate, onConnection);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Answers the first STUN request on the connection with answer(request). */
const answeringWith = (answer) => (socket) => {
  let received = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    received = Buffer.concat([received, chunk]);
    if (received.length >= 20) socket.write(answer(received.subarray(0, 20)));
  });
  socket.on('error', () => {});
};

describe('stunOverTls', () => {
  let certificates;
  before(() => {
    certificates = makeCertificates();
  });

  test('passes, with the days left, for a trusted certificate and a matching answer', async () => {
    const server = await tlsServer(
      certificates.localhost,
      answeringWith((request) => bindingSuccess(request.subarray(8, 20))),
    );
    try {
      const result = await stunOverTls({
        host: 'localhost',
        port: server.port,
        timeoutMs: 3000,
        ca: certificates.ca,
      });
      assert.equal(result.ok, true);
      assert.ok(result.daysLeft >= 29 && result.daysLeft <= 30, String(result.daysLeft));
    } finally {
      await server.close();
    }
  });

  test('fails for a certificate made out to another name, and learns no expiry', async () => {
    const server = await tlsServer(
      certificates.otherName,
      answeringWith((request) => bindingSuccess(request.subarray(8, 20))),
    );
    try {
      const result = await stunOverTls({
        host: 'localhost',
        port: server.port,
        timeoutMs: 3000,
        ca: certificates.ca,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'ERR_TLS_CERT_ALTNAME_INVALID');
      assert.equal(result.daysLeft, undefined);
    } finally {
      await server.close();
    }
  });

  test('fails for a certificate from a CA the system does not trust', async () => {
    const server = await tlsServer(
      certificates.localhost,
      answeringWith((request) => bindingSuccess(request.subarray(8, 20))),
    );
    try {
      const result = await stunOverTls({ host: 'localhost', port: server.port, timeoutMs: 3000 });
      assert.equal(result.ok, false);
      assert.equal(result.daysLeft, undefined);
    } finally {
      await server.close();
    }
  });

  test('fails on an answer to another transaction, but still reports the days left', async () => {
    const server = await tlsServer(
      certificates.localhost,
      answeringWith(() => bindingSuccess(Buffer.alloc(12, 0xff))),
    );
    try {
      const result = await stunOverTls({
        host: 'localhost',
        port: server.port,
        timeoutMs: 3000,
        ca: certificates.ca,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'not a matching Binding success');
      assert.equal(typeof result.daysLeft, 'number');
    } finally {
      await server.close();
    }
  });

  test('fails on an oversized answer, a trailing extra message and a closed connection', async () => {
    const cases = [
      [() => Buffer.alloc(MAX_MESSAGE_BYTES + 1, 1), 'answer too long'],
      [
        (request) => Buffer.concat([bindingSuccess(request.subarray(8, 20)), Buffer.alloc(20, 0)]),
        'not a matching Binding success',
      ],
    ];
    for (const [answer, reason] of cases) {
      const server = await tlsServer(certificates.localhost, answeringWith(answer));
      try {
        const result = await stunOverTls({
          host: 'localhost',
          port: server.port,
          timeoutMs: 3000,
          ca: certificates.ca,
        });
        assert.deepEqual([result.ok, result.reason], [false, reason]);
      } finally {
        await server.close();
      }
    }
    const closing = await tlsServer(certificates.localhost, (socket) => {
      socket.on('data', () => socket.end());
      socket.on('error', () => {});
    });
    try {
      const result = await stunOverTls({
        host: 'localhost',
        port: closing.port,
        timeoutMs: 3000,
        ca: certificates.ca,
      });
      assert.deepEqual([result.ok, result.reason], [false, 'closed before answering']);
    } finally {
      await closing.close();
    }
  });
});

describe('main', () => {
  let certificates;
  let udp;
  let silentUdp;
  let overTls;
  before(async () => {
    certificates = makeCertificates();
    udp = await udpServer((request) => bindingSuccess(request.subarray(8, 20)));
    silentUdp = await udpServer(() => undefined);
    overTls = await tlsServer(
      certificates.localhost,
      answeringWith((request) => bindingSuccess(request.subarray(8, 20))),
    );
  });
  after(async () => {
    udp.close();
    silentUdp.close();
    await overTls.close();
  });

  const run = async (options) => {
    const lines = [];
    const failures = await main({
      host: 'localhost',
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
    const { failures, lines } = await run({ udpPort: udp.port });
    assert.equal(failures, 0);
    assert.deepEqual(lines, [
      `up:   turn:localhost:${udp.port} (STUN over UDP)`,
      `up:   turns:localhost:${overTls.port} (STUN over TLS)`,
      lines[2],
    ]);
    assert.match(lines[2], /^certificate ok: (29|30) days left$/);
  });

  test('prints DOWN after the tries, and never the server’s answer', async () => {
    const { failures, lines } = await run({ udpPort: silentUdp.port });
    assert.equal(failures, 1);
    assert.deepEqual(lines.slice(0, 3), [
      `try 1: turn:localhost:${silentUdp.port}: no answer`,
      `try 2: turn:localhost:${silentUdp.port}: no answer`,
      `DOWN: turn:localhost:${silentUdp.port} (STUN over UDP)`,
    ]);
  });

  test('prints CERTIFICATE EXPIRES SOON below the threshold', async () => {
    const { failures, lines } = await run({ udpPort: udp.port, minDaysLeft: 31 });
    assert.equal(failures, 0);
    assert.match(lines.at(-1), /^CERTIFICATE EXPIRES SOON: (29|30) days left$/);
  });

  test('prints no certificate line when the handshake never completed', async () => {
    const { failures, lines } = await run({ udpPort: udp.port, ca: undefined });
    assert.equal(failures, 1);
    assert.equal(lines.at(-1), `DOWN: turns:localhost:${overTls.port} (STUN over TLS)`);
    assert.ok(!lines.some((line) => /certificate/i.test(line)));
  });
});
