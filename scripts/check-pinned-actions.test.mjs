// Tests for check-pinned-actions.mjs. Run with: node --test 'scripts/*.test.mjs'
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  findUnpinnedActions,
  findUnpinnedActionsInRepository,
  main,
} from './check-pinned-actions.mjs';

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = join(import.meta.dirname, 'check-pinned-actions.mjs');

function makeRepository(files) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'pinned-actions-'));
  mkdirSync(join(repositoryRoot, '.github', 'workflows'), { recursive: true });
  for (const [relativePath, text] of Object.entries(files)) {
    mkdirSync(join(repositoryRoot, relativePath, '..'), { recursive: true });
    writeFileSync(join(repositoryRoot, relativePath), text);
  }
  return repositoryRoot;
}

test('the repository itself is fully pinned', () => {
  assert.deepEqual(findUnpinnedActionsInRepository(REPOSITORY_ROOT), []);
});

test('the accepted form passes: pinned, local and digest-pinned docker actions', () => {
  for (const line of [
    `      - uses: actions/checkout@${SHA} # v7.0.1`,
    `        uses: pnpm/action-setup@${SHA}`,
    `    uses: org/repo/.github/workflows/build.yml@${SHA}`,
    '      - uses: ./.github/actions/local-thing',
    `      - uses: docker://alpine:3@${DIGEST}`,
    '      # uses: actions/checkout@v7 (a comment is not a step)',
    '      - name: Build what this uses', // the word, not a key
  ]) {
    assert.deepEqual(findUnpinnedActions(line), [], line);
  }
});

test('negative: unpinned references fail', () => {
  for (const line of [
    '      - uses: actions/checkout@v7',
    '      - uses: actions/checkout@main',
    '      - uses: actions/checkout@3d3c42e',
    '      - uses: actions/checkout',
    `      - uses: actions/checkout@${SHA.toUpperCase()}`,
    `      - uses: actions/checkout@v7@${SHA}`, // ends in a SHA but is not one
    '      - uses: docker://alpine:3',
    '    uses: org/repo/.github/workflows/build.yml@v1',
  ]) {
    assert.equal(findUnpinnedActions(line).length, 1, line);
  }
});

test('negative: every other way of writing uses is reported, pinned or not', () => {
  for (const text of [
    '      - uses:\n          actions/checkout@v7', // value on the next line
    '      - { uses: actions/checkout@v7 }',
    `      - { uses: actions/checkout@${SHA} }`, // even pinned: flow style is not read
    '    steps: [ {uses: actions/checkout@v7} ]',
    'jobs: { call: { uses: org/repo/.github/workflows/x.yml@v1 } }',
    '      - "uses": actions/checkout@v7',
    "      - 'uses': actions/checkout@v7",
    '      - uses : actions/checkout@v7',
    '      - ? uses\n        : actions/checkout@v7',
    `      - uses: "actions/checkout@v7 @${SHA}"`,
    `      - uses: actions/checkout@${SHA}'x`,
    '      - uses: >-\n          actions/checkout@v7',
    '      - Uses: actions/checkout@v7', // not a key GitHub knows, but never let it pass
  ]) {
    assert.ok(findUnpinnedActions(text).length >= 1, text);
  }
});

test('negative: local action metadata is scanned too', () => {
  const repositoryRoot = makeRepository({
    '.github/workflows/ci.yml': 'steps:\n  - uses: ./.github/actions/setup\n',
    '.github/actions/setup/action.yml': 'runs:\n  steps:\n    - uses: actions/cache@v4\n',
  });

  assert.deepEqual(findUnpinnedActionsInRepository(repositoryRoot), [
    '.github/actions/setup/action.yml:3: actions/cache@v4',
  ]);
});

test('negative: main reports each unpinned action with its line and fails', (context) => {
  const logged = [];
  context.mock.method(console, 'log', (message) => logged.push(message));
  const repositoryRoot = makeRepository({
    '.github/workflows/ci.yml': `steps:\n  - uses: actions/checkout@${SHA}\n  - uses: actions/setup-node@v7\n`,
  });

  assert.equal(main([repositoryRoot]), 1);
  assert.ok(logged.includes('not pinned: .github/workflows/ci.yml:3: actions/setup-node@v7'));
});

test('main passes when everything is pinned', (context) => {
  context.mock.method(console, 'log', () => {});
  const repositoryRoot = makeRepository({
    '.github/workflows/ci.yml': `steps:\n  - uses: actions/checkout@${SHA}\n`,
  });

  assert.equal(main([repositoryRoot]), 0);
});

test('negative: run as a script, also through a symlink, it exits 1 on an unpinned action', () => {
  const repositoryRoot = makeRepository({
    '.github/workflows/ci.yml': 'steps:\n  - uses: actions/checkout@v7\n',
  });
  const symlinkedScript = join(mkdtempSync(join(tmpdir(), 'pinned-link-')), 'check.mjs');
  symlinkSync(SCRIPT_PATH, symlinkedScript);

  for (const scriptPath of [SCRIPT_PATH, symlinkedScript]) {
    const result = spawnSync(process.execPath, [scriptPath, repositoryRoot], { encoding: 'utf8' });
    assert.equal(result.status, 1, `${scriptPath}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /actions\/checkout@v7/);
  }
});
