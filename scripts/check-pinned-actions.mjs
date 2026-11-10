// Fails when a GitHub Action is not pinned to a full commit SHA.
//
// A tag or branch (`@v7`, `@main`) can be moved to other code, so every `uses:` must name a
// 40-character commit SHA, with the version as a comment: `actions/checkout@<sha> # v7.0.1`.
// Local actions (`./...`) are allowed (their own action.yml is checked too); `docker://` images
// need an `@sha256:` digest. Dependabot keeps the pins up to date. Same rule as
// secure-call-backend's scripts/check_pinned_references.py.
//
// It reads lines, not YAML, so it fails closed: exactly one form is accepted,
// `uses: <reference>` on one line, unquoted, optionally after `- ` and before a `# comment`.
// Any other way of writing a `uses` key (flow style, quoted keys, the value on the next line,
// a space before the colon, `? uses`) is reported, never skipped.
//
// Usage: node scripts/check-pinned-actions.mjs [REPOSITORY_ROOT]
// Prints one line per problem and exits 1, or exits 0 when everything is pinned.
// Node standard library only, so CI can run it before anything is installed.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A `uses` key in any form, including a YAML complex key (`? uses`, value on the next line).
const ANY_USES_KEY = /(?:^|[\s{,[?])['"]?uses['"]?\s*:/i;
const COMPLEX_USES_KEY = /^\s*(?:-\s+)?\?\s+['"]?uses['"]?\s*$/i;
const ACCEPTED_USES_LINE = /^\s*(?:-\s+)?uses:\s+(?<reference>[^\s#'"{}[\],]+)\s*(?:#.*)?$/;
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const PINNED_DOCKER_IMAGE = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
const LOCAL_ACTION = /^\.\/[^\s]*$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.reference', 'dist', 'coverage']);

function isPinned(reference) {
  return (
    LOCAL_ACTION.test(reference) ||
    PINNED_DOCKER_IMAGE.test(reference) ||
    PINNED_ACTION.test(reference)
  );
}

/** Every unpinned or unreadable `uses` in one file, as { lineNumber, reference }. */
export function findUnpinnedActions(workflowText) {
  const problems = [];
  workflowText.split(/\r?\n/).forEach((line, index) => {
    if (line.trimStart().startsWith('#')) return;
    if (!ANY_USES_KEY.test(line) && !COMPLEX_USES_KEY.test(line)) return;
    const reference = ACCEPTED_USES_LINE.exec(line)?.groups?.reference;
    if (reference === undefined) {
      problems.push({ lineNumber: index + 1, reference: `unsupported form: ${line.trim()}` });
    } else if (!isPinned(reference)) {
      problems.push({ lineNumber: index + 1, reference });
    }
  });
  return problems;
}

/** Workflow files and local action metadata (action.yml) anywhere in the repository. */
export function findActionFiles(repositoryRoot) {
  const workflowsDirectory = join(repositoryRoot, '.github', 'workflows');
  const files = readdirSync(workflowsDirectory)
    .filter((fileName) => /\.ya?ml$/.test(fileName))
    .map((fileName) => join(workflowsDirectory, fileName));
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (/^action\.ya?ml$/.test(entry.name)) files.push(entryPath);
    }
  };
  visit(repositoryRoot);
  return [...new Set(files)].sort();
}

/** Every problem in the repository, as `path:line: reference`. */
export function findUnpinnedActionsInRepository(repositoryRoot) {
  return findActionFiles(repositoryRoot).flatMap((filePath) => {
    const relativePath = relative(repositoryRoot, filePath).split('\\').join('/');
    return findUnpinnedActions(readFileSync(filePath, 'utf8')).map(
      ({ lineNumber, reference }) => `${relativePath}:${lineNumber}: ${reference}`,
    );
  });
}

export function main(commandLineArguments) {
  const repositoryRoot = resolve(commandLineArguments[0] ?? '.');
  const problems = findUnpinnedActionsInRepository(repositoryRoot);
  for (const problem of problems) console.log(`not pinned: ${problem}`);
  if (problems.length > 0) {
    console.log(`${problems.length} action(s) not pinned. Pin each to a full commit SHA.`);
    return 1;
  }
  console.log('All actions are pinned.');
  return 0;
}

// Run as a script (also through a symlinked path: compare real paths, never fail open).
const invokedPath = process.argv[1] === undefined ? '' : realpathSync(process.argv[1]);
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
