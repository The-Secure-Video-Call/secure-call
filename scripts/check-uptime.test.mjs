// Tests for check-uptime.sh. Run with: node --test 'scripts/*.test.mjs'
// The script runs for real under bash, with stand-ins for curl, gh and node on PATH. The gh
// stand-in records every call, so the tests see exactly which issues would be opened or closed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SCRIPT = join(import.meta.dirname, 'check-uptime.sh');
const WORKFLOW = join(import.meta.dirname, '..', '.github', 'workflows', 'uptime.yml');
const DOWN_TITLE = 'Uptime: securevideocall.com is down';
const CERTIFICATE_TITLE = 'Uptime: the TURN certificate expires within 21 days';
const TURN_UP = [
  'up:   turn:turn.securevideocall.com:3478 (STUN over UDP)',
  'up:   turns:turn.securevideocall.com:5349 (STUN over TLS)',
];

function stub(folder, name, body) {
  const path = join(folder, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * Runs check-uptime.sh. `failingUrls`: URLs curl fails for. `turnLines`/`turnExit`: what the node
 * stand-in prints and exits with. `openDown`/`openCertificate`: issue numbers gh lists as open.
 */
function runCheck({
  failingUrls = [],
  turnLines = [...TURN_UP, 'certificate ok: 89 days left'],
  turnExit = 0,
  openDown = '',
  openCertificate = '',
} = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'check-uptime-'));
  const ghLog = join(folder, 'gh.log');
  writeFileSync(ghLog, '');
  stub(
    folder,
    'curl',
    [
      'url="${@: -1}"',
      'case " $FAILING_URLS " in *" $url "*) echo "curl: (22) 502" >&2; exit 22 ;; esac',
      'case "$url" in',
      '  https://securevideocall.com/) echo \'<html><div id="root"></div></html>\' ;;',
      '  https://signal.securevideocall.com/healthz) echo \'{"status": "ok"}\' ;;',
      '  *) exit 6 ;;',
      'esac',
    ].join('\n'),
  );
  stub(folder, 'node', 'printf "%s" "$TURN_OUTPUT"\nexit "$TURN_EXIT"');
  stub(
    folder,
    'gh',
    [
      // One record per call (\x1e), one field per argument (\x1f): bodies contain newlines.
      'printf "%s\\x1f" "$@" >> "$GH_LOG"; printf "\\x1e" >> "$GH_LOG"',
      'if [ "$1 $2" = "issue list" ]; then',
      `  case "$*" in *"${CERTIFICATE_TITLE}"*) printf "%s" "$OPEN_CERTIFICATE" ;; *) printf "%s" "$OPEN_DOWN" ;; esac`,
      'fi',
    ].join('\n'),
  );
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${folder}:${process.env.PATH}`,
      HOME: folder,
      FAILING_URLS: failingUrls.join(' '),
      TURN_OUTPUT: turnLines.length ? `${turnLines.join('\n')}\n` : '',
      TURN_EXIT: String(turnExit),
      OPEN_DOWN: openDown,
      OPEN_CERTIFICATE: openCertificate,
      GH_LOG: ghLog,
      UPTIME_RETRY_SECONDS: '0',
      RUN_URL: 'https://github.com/example/run/1',
    },
  });
  const calls = readFileSync(ghLog, 'utf8')
    .split('\x1e')
    .filter(Boolean)
    .map((line) => line.split('\x1f').filter(Boolean));
  return {
    status: result.status,
    stdout: result.stdout,
    creates: calls.filter((args) => args[0] === 'issue' && args[1] === 'create'),
    closes: calls.filter((args) => args[0] === 'issue' && args[1] === 'close'),
  };
}

const option = (args, name) => args[args.indexOf(name) + 1];

test('everything up and the certificate ok: no issue is opened or closed', () => {
  const run = runCheck();
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual([run.creates, run.closes], [[], []]);
  assert.ok(run.stdout.includes(TURN_UP[1]), run.stdout);
});

test('TURN over UDP down: the downtime issue opens and names the TURN target', () => {
  const run = runCheck({
    turnLines: [
      'DOWN: turn:turn.securevideocall.com:3478 (STUN over UDP)',
      TURN_UP[1],
      'certificate ok: 89 days left',
    ],
  });
  assert.equal(run.status, 0, run.stdout);
  assert.equal(run.creates.length, 1);
  assert.equal(option(run.creates[0], '--title'), DOWN_TITLE);
  const body = option(run.creates[0], '--body');
  assert.match(body, /^- turn:turn\.securevideocall\.com:3478$/m);
  assert.doesNotMatch(body, /STUN over UDP/);
  assert.match(body, /check coturn on the Pi 5/);
});

test('a failing URL still opens the downtime issue alongside TURN', () => {
  const run = runCheck({ failingUrls: ['https://signal.securevideocall.com/healthz'] });
  assert.equal(run.creates.length, 1);
  assert.match(
    option(run.creates[0], '--body'),
    /^- https:\/\/signal\.securevideocall\.com\/healthz$/m,
  );
});

test('a certificate expiring soon opens the certificate issue, not the downtime one', () => {
  const run = runCheck({ turnLines: [...TURN_UP, 'CERTIFICATE EXPIRES SOON: 12 days left'] });
  assert.equal(run.status, 0, run.stdout);
  assert.equal(run.creates.length, 1);
  assert.equal(option(run.creates[0], '--title'), CERTIFICATE_TITLE);
  assert.match(option(run.creates[0], '--body'), /expires in 12 days/);
});

test('a certificate expiring soon with its issue already open: nothing new is opened', () => {
  const run = runCheck({
    turnLines: [...TURN_UP, 'CERTIFICATE EXPIRES SOON: 12 days left'],
    openCertificate: '7',
  });
  assert.deepEqual([run.creates, run.closes], [[], []]);
});

test('a renewed certificate closes the open certificate issue', () => {
  const run = runCheck({ openCertificate: '7' });
  assert.equal(run.closes.length, 1);
  assert.equal(run.closes[0][2], '7');
  assert.match(option(run.closes[0], '--comment'), /89 days left/);
});

test('TLS down: no certificate line, so the open certificate issue is left alone', () => {
  const run = runCheck({
    turnLines: [TURN_UP[0], 'DOWN: turns:turn.securevideocall.com:5349 (STUN over TLS)'],
    openCertificate: '7',
  });
  assert.deepEqual(run.closes, []);
  assert.equal(run.creates.length, 1);
  assert.equal(option(run.creates[0], '--title'), DOWN_TITLE);
  assert.match(option(run.creates[0], '--body'), /^- turns:turn\.securevideocall\.com:5349$/m);
});

test('everything answers again: the open downtime issue closes', () => {
  const run = runCheck({ openDown: '5' });
  assert.equal(run.closes.length, 1);
  assert.equal(run.closes[0][2], '5');
  assert.match(option(run.closes[0], '--comment'), /Everything answers again/);
});

test('a broken TURN check fails the run and never closes the downtime issue', () => {
  const run = runCheck({ turnLines: [], turnExit: 2, openDown: '5', openCertificate: '7' });
  assert.equal(run.status, 1);
  assert.deepEqual([run.creates, run.closes], [[], []]);
  assert.match(run.stdout, /The TURN check did not run \(exit code 2\)/);
});

test('a broken TURN check still lets a failing URL open the downtime issue', () => {
  const run = runCheck({
    turnLines: ['DOWN: turn:turn.securevideocall.com:3478 (STUN over UDP)'],
    turnExit: 2,
    failingUrls: ['https://securevideocall.com/'],
  });
  assert.equal(run.status, 1);
  assert.equal(run.creates.length, 1);
  const body = option(run.creates[0], '--body');
  assert.match(body, /^- https:\/\/securevideocall\.com\/$/m);
  // Lines from a check that broke are not trusted: only the URL is listed.
  assert.deepEqual(body.match(/^- .*$/gm), ['- https://securevideocall.com/']);
});

test('the workflow checks out both scripts it runs', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /^ {12}scripts\/check-uptime\.sh$/m);
  assert.match(workflow, /^ {12}scripts\/check-turn\.mjs$/m);
});
