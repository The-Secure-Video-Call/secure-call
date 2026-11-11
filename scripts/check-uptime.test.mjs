// Tests for check-uptime.sh. Run with: node --test 'scripts/*.test.mjs'
// The script runs for real under bash, with stand-ins for curl, gh and node on PATH. The gh
// stand-in records every call and applies the script's own --jq filter (with jq) to a list of
// open issues, so the exact title and author matching is tested too.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const SCRIPT = join(import.meta.dirname, 'check-uptime.sh');
const WORKFLOW = join(import.meta.dirname, '..', '.github', 'workflows', 'uptime.yml');
const DOWN_TITLE = 'Uptime: securevideocall.com is down';
const CERTIFICATE_TITLE = 'Uptime: the TURN certificate expires within 21 days';
const BOT = { login: 'app/github-actions' };
const UDP_UP = 'up:   turn:turn.securevideocall.com:3478 (STUN over UDP)';
const TLS_UP = 'up:   turns:turn.securevideocall.com:5349 (STUN over TLS)';
const UDP_DOWN = 'DOWN: turn:turn.securevideocall.com:3478 (STUN over UDP)';
const TLS_DOWN = 'DOWN: turns:turn.securevideocall.com:5349 (STUN over TLS)';
const CERTIFICATE_OK = 'certificate ok: 89 days left';

const folders = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

function stub(folder, name, body) {
  const path = join(folder, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * Runs check-uptime.sh. `failingUrls`: URLs curl fails for. `turnLines`/`turnExit`: what the node
 * stand-in prints and exits with. `openIssues`: the open issues gh lists ({number, title,
 * author}); `issueBody`: what `gh issue view` returns. `listFails`/`viewFails`: gh issue list
 * or view fails.
 */
function runCheck({
  failingUrls = [],
  turnLines = [UDP_UP, TLS_UP, CERTIFICATE_OK],
  turnExit = 0,
  openIssues = [],
  issueBody = '',
  listFails = false,
  viewFails = false,
  dryRun = false,
} = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'check-uptime-'));
  folders.push(folder);
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
      '  if [ "$GH_LIST_FAILS" = 1 ]; then exit 1; fi',
      '  previous=""; for arg in "$@"; do [ "$previous" = "--jq" ] && filter="$arg"; previous="$arg"; done',
      '  printf "%s" "$OPEN_ISSUES" | jq -r "$filter"',
      'fi',
      'if [ "$1 $2" = "issue view" ]; then',
      '  if [ "$GH_VIEW_FAILS" = 1 ]; then exit 1; fi',
      '  printf "%s" "$ISSUE_BODY"',
      'fi',
    ].join('\n'),
  );
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${folder}:${process.env.PATH}`,
      HOME: folder,
      TMPDIR: folder,
      FAILING_URLS: failingUrls.join(' '),
      TURN_OUTPUT: turnLines.length ? `${turnLines.join('\n')}\n` : '',
      TURN_EXIT: String(turnExit),
      OPEN_ISSUES: JSON.stringify(openIssues),
      ISSUE_BODY: issueBody,
      GH_LIST_FAILS: listFails ? '1' : '0',
      GH_VIEW_FAILS: viewFails ? '1' : '0',
      GH_LOG: ghLog,
      UPTIME_RETRY_SECONDS: '0',
      UPTIME_DRY_RUN: dryRun ? '1' : '0',
      RUN_URL: 'https://github.com/example/run/1',
    },
  });
  const calls = readFileSync(ghLog, 'utf8')
    .split('\x1e')
    .filter(Boolean)
    .map((record) => record.split('\x1f').filter(Boolean));
  const of = (verb) => calls.filter((args) => args[0] === 'issue' && args[1] === verb);
  return {
    status: result.status,
    stdout: result.stdout,
    creates: of('create'),
    closes: of('close'),
    comments: of('comment'),
    edits: of('edit'),
  };
}

const option = (args, name) => args[args.indexOf(name) + 1];
const listed = (body) => body.match(/^- .*$/gm) ?? [];
const changes = (run) => [run.creates, run.closes, run.comments, run.edits];
const NO_CHANGES = [[], [], [], []];

test('everything up and the certificate ok: no issue is opened or closed', () => {
  const run = runCheck();
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(changes(run), NO_CHANGES);
  assert.ok(run.stdout.includes(TLS_UP), run.stdout);
});

test('TURN over UDP down: the downtime issue opens and names the TURN target', () => {
  const run = runCheck({ turnLines: [UDP_DOWN, TLS_UP, CERTIFICATE_OK] });
  assert.equal(run.status, 0, run.stdout);
  assert.equal(run.creates.length, 1);
  assert.equal(option(run.creates[0], '--title'), DOWN_TITLE);
  const body = option(run.creates[0], '--body');
  assert.deepEqual(listed(body), ['- turn:turn.securevideocall.com:3478']);
  assert.match(body, /check coturn on the main Pi/);
  // Roles, not machine names: the repository is public.
  assert.doesNotMatch(body, /Pi 5|Pi Zero/);
});

test('a failing URL and a failing TURN target are listed together', () => {
  const run = runCheck({
    failingUrls: ['https://signal.securevideocall.com/healthz'],
    turnLines: [UDP_UP, TLS_DOWN],
  });
  assert.equal(run.creates.length, 1);
  assert.deepEqual(listed(option(run.creates[0], '--body')), [
    '- https://signal.securevideocall.com/healthz',
    '- turns:turn.securevideocall.com:5349',
  ]);
});

test('a new failure while the downtime issue is open is commented and added to the body', () => {
  const body =
    'Detected at …:\n\n- turn:turn.securevideocall.com:3478\n\nThis issue closes itself.';
  const run = runCheck({
    failingUrls: ['https://signal.securevideocall.com/healthz'],
    turnLines: [UDP_DOWN, TLS_UP, CERTIFICATE_OK],
    openIssues: [{ number: 5, title: DOWN_TITLE, author: BOT }],
    issueBody: body,
  });
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(run.creates, []);
  assert.equal(run.comments.length, 1);
  assert.equal(run.comments[0][2], '5');
  assert.deepEqual(listed(option(run.comments[0], '--body')), [
    '- https://signal.securevideocall.com/healthz',
  ]);
  assert.equal(run.edits.length, 1);
  assert.equal(
    option(run.edits[0], '--body'),
    `${body}\n- https://signal.securevideocall.com/healthz`,
  );
});

test('a failure already listed in the open issue is not reported again', () => {
  const run = runCheck({
    turnLines: [UDP_DOWN, TLS_UP, CERTIFICATE_OK],
    openIssues: [{ number: 5, title: DOWN_TITLE, author: BOT }],
    issueBody: 'Detected:\n\n- turn:turn.securevideocall.com:3478\n\nHelp.',
  });
  assert.deepEqual(changes(run), NO_CHANGES);
});

test('a body saved in the web editor (CRLF line ends) is not re-reported', () => {
  const run = runCheck({
    turnLines: [UDP_DOWN, TLS_UP, CERTIFICATE_OK],
    openIssues: [{ number: 5, title: DOWN_TITLE, author: BOT }],
    issueBody: 'Detected:\r\n\r\n- turn:turn.securevideocall.com:3478\r\n\r\nHelp.',
  });
  assert.deepEqual(changes(run), NO_CHANGES);
});

test('when the open issue cannot be read, the run fails and changes nothing', () => {
  const run = runCheck({
    turnLines: [UDP_DOWN, TLS_UP, CERTIFICATE_OK],
    openIssues: [{ number: 5, title: DOWN_TITLE, author: BOT }],
    viewFails: true,
  });
  assert.equal(run.status, 1);
  assert.deepEqual(changes(run), NO_CHANGES);
  assert.match(run.stdout, /Could not read issue #5/);
});

test('issues with our titles that someone else opened are ignored', () => {
  const outsider = { login: 'someone' };
  const run = runCheck({
    turnLines: [UDP_DOWN, TLS_UP, CERTIFICATE_OK],
    openIssues: [
      { number: 8, title: DOWN_TITLE, author: outsider },
      { number: 9, title: `${DOWN_TITLE} (copy)`, author: BOT },
    ],
  });
  assert.equal(run.creates.length, 1, 'a real outage is not hidden by them');
  const recovered = runCheck({
    openIssues: [
      { number: 8, title: DOWN_TITLE, author: outsider },
      { number: 10, title: CERTIFICATE_TITLE, author: outsider },
    ],
  });
  assert.deepEqual(changes(recovered), NO_CHANGES, 'and never closed by us');
});

test('a certificate expiring soon opens the certificate issue, not the downtime one', () => {
  const run = runCheck({ turnLines: [UDP_UP, TLS_UP, 'CERTIFICATE EXPIRES SOON: 12 days left'] });
  assert.equal(run.status, 0, run.stdout);
  assert.equal(run.creates.length, 1);
  assert.equal(option(run.creates[0], '--title'), CERTIFICATE_TITLE);
  assert.match(option(run.creates[0], '--body'), /expires in 12 days/);
});

test('a certificate expiring soon with its issue already open: nothing changes', () => {
  const run = runCheck({
    turnLines: [UDP_UP, TLS_UP, 'CERTIFICATE EXPIRES SOON: 12 days left'],
    openIssues: [{ number: 7, title: CERTIFICATE_TITLE, author: BOT }],
  });
  assert.deepEqual(changes(run), NO_CHANGES);
});

test('a renewed certificate closes the open certificate issue', () => {
  const run = runCheck({ openIssues: [{ number: 7, title: CERTIFICATE_TITLE, author: BOT }] });
  assert.equal(run.closes.length, 1);
  assert.equal(run.closes[0][2], '7');
  assert.match(option(run.closes[0], '--comment'), /89 days left/);
});

test('TLS down: no certificate line, so the open certificate issue is left alone', () => {
  const run = runCheck({
    turnLines: [UDP_UP, TLS_DOWN],
    openIssues: [{ number: 7, title: CERTIFICATE_TITLE, author: BOT }],
  });
  assert.deepEqual(run.closes, []);
  assert.equal(run.creates.length, 1);
  assert.equal(option(run.creates[0], '--title'), DOWN_TITLE);
  assert.deepEqual(listed(option(run.creates[0], '--body')), [
    '- turns:turn.securevideocall.com:5349',
  ]);
});

test('everything answers again: the open downtime issue closes', () => {
  const run = runCheck({ openIssues: [{ number: 5, title: DOWN_TITLE, author: BOT }] });
  assert.equal(run.closes.length, 1);
  assert.equal(run.closes[0][2], '5');
  assert.match(option(run.closes[0], '--comment'), /Everything answers again/);
});

const OPEN_BOTH = [
  { number: 5, title: DOWN_TITLE, author: BOT },
  { number: 7, title: CERTIFICATE_TITLE, author: BOT },
];

test('a TURN check that exits 2 fails the run and closes nothing', () => {
  const run = runCheck({ turnLines: [], turnExit: 2, openIssues: OPEN_BOTH });
  assert.equal(run.status, 1);
  assert.deepEqual(changes(run), NO_CHANGES);
  assert.match(run.stdout, /The TURN check did not run \(exit code 2\)/);
});

test('a TURN check that exits 0 with missing or repeated lines counts as broken', () => {
  for (const turnLines of [[], [UDP_UP], [UDP_UP, UDP_UP, TLS_UP, CERTIFICATE_OK]]) {
    const run = runCheck({ turnLines, openIssues: OPEN_BOTH });
    assert.equal(run.status, 1, turnLines.join(' | '));
    assert.deepEqual(changes(run), NO_CHANGES, turnLines.join(' | '));
    assert.match(run.stdout, /The TURN check reported/);
  }
});

test('a broken TURN check still lets a failing URL open the downtime issue', () => {
  const run = runCheck({
    turnLines: [UDP_DOWN],
    turnExit: 2,
    failingUrls: ['https://securevideocall.com/'],
  });
  assert.equal(run.status, 1);
  assert.equal(run.creates.length, 1);
  // Lines from a check that broke are not trusted: only the URL is listed.
  assert.deepEqual(listed(option(run.creates[0], '--body')), ['- https://securevideocall.com/']);
});

test('when the issues cannot be read, the run fails and changes nothing', () => {
  const run = runCheck({ turnLines: [UDP_DOWN, TLS_UP, CERTIFICATE_OK], listFails: true });
  assert.equal(run.status, 1);
  assert.deepEqual(changes(run), NO_CHANGES);
});

test('a dry run prints what it would do and changes nothing', () => {
  const run = runCheck({
    turnLines: [UDP_DOWN, TLS_UP, 'CERTIFICATE EXPIRES SOON: 12 days left'],
    dryRun: true,
  });
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(changes(run), NO_CHANGES);
  assert.match(run.stdout, /DRY RUN: gh issue create --title Uptime: securevideocall\.com is down/);
  assert.match(run.stdout, /DRY RUN: gh issue create --title Uptime: the TURN certificate/);
});

test('the workflow checks out both scripts, and only a manual run can be a dry run', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /^ {12}scripts\/check-uptime\.sh$/m);
  assert.match(workflow, /^ {12}scripts\/check-turn\.mjs$/m);
  assert.ok(
    workflow.includes(
      "UPTIME_DRY_RUN: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && '1' || '0' }}",
    ),
  );
});
