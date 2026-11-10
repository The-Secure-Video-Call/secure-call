// Tests for check-pinned-actions.mjs. Run with: node --test 'scripts/*.test.mjs'
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

function makeRepository(workflowText) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'pinned-actions-'));
  mkdirSync(join(repositoryRoot, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), workflowText);
  return repositoryRoot;
}

test('the repository itself is fully pinned', () => {
  assert.deepEqual(findUnpinnedActionsInRepository(REPOSITORY_ROOT), []);
});

test('pinned, local and digest-pinned docker actions pass', () => {
  for (const line of [
    `      - uses: actions/checkout@${SHA} # v7.0.1`,
    `        uses: 'pnpm/action-setup@${SHA}'`,
    '      - uses: ./.github/actions/local-thing',
    `      - uses: docker://alpine:3@${DIGEST}`,
  ]) {
    assert.deepEqual(findUnpinnedActions(line), [], line);
  }
});

test('negative: tags, branches, short or missing refs and undigested images fail', () => {
  for (const line of [
    '      - uses: actions/checkout@v7',
    '      - uses: actions/checkout@main',
    '      - uses: actions/checkout@3d3c42e',
    '      - uses: actions/checkout',
    '        uses: "anthropics/claude-code-action@v1"',
    `      - uses: actions/checkout@${SHA.toUpperCase()}`,
    '      - uses: docker://alpine:3',
  ]) {
    assert.equal(findUnpinnedActions(line).length, 1, line);
  }
});

test('negative: main reports each unpinned action with its line and fails', (context) => {
  const logged = [];
  context.mock.method(console, 'log', (message) => logged.push(message));
  const repositoryRoot = makeRepository(
    `steps:\n  - uses: actions/checkout@${SHA}\n  - uses: actions/setup-node@v7\n`,
  );

  assert.equal(main([repositoryRoot]), 1);
  assert.ok(logged.includes('not pinned: .github/workflows/ci.yml:3: actions/setup-node@v7'));
});

test('main passes when everything is pinned', (context) => {
  context.mock.method(console, 'log', () => {});
  const repositoryRoot = makeRepository(`steps:\n  - uses: actions/checkout@${SHA}\n`);

  assert.equal(main([repositoryRoot]), 0);
});
