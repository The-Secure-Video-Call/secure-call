// Fails when a GitHub Action in .github/workflows/ is not pinned to a full commit SHA.
//
// A tag or branch (`@v7`, `@main`) can be moved to other code, so every `uses:` must name a
// 40-character commit SHA, with the version as a comment: `actions/checkout@<sha> # v7.0.1`.
// Local actions (`./...`) are allowed; `docker://` images need an `@sha256:` digest.
// Dependabot keeps the pins up to date. Same rule as secure-call-backend's
// scripts/check_pinned_references.py.
//
// Usage: node scripts/check-pinned-actions.mjs [REPOSITORY_ROOT]
// Prints one line per unpinned action and exits 1, or exits 0 when everything is pinned.
// Node standard library only, so CI can run it before anything is installed.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USES_LINE = /^\s*(?:-\s+)?uses:\s*['"]?(?<reference>[^'"\s#]+)/;
const FULL_COMMIT_SHA = /@[0-9a-f]{40}$/;
const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/;

/** Every `uses:` in one workflow that is not pinned, as { lineNumber, reference }. */
export function findUnpinnedActions(workflowText) {
  const unpinnedActions = [];
  workflowText.split('\n').forEach((line, index) => {
    const reference = USES_LINE.exec(line)?.groups?.reference;
    if (reference === undefined || reference.startsWith('./')) return;
    const pinned = reference.startsWith('docker://')
      ? IMAGE_DIGEST.test(reference)
      : FULL_COMMIT_SHA.test(reference);
    if (!pinned) unpinnedActions.push({ lineNumber: index + 1, reference });
  });
  return unpinnedActions;
}

/** Every unpinned action under REPOSITORY_ROOT/.github/workflows, as `path:line: reference`. */
export function findUnpinnedActionsInRepository(repositoryRoot) {
  const workflowsDirectory = join(repositoryRoot, '.github', 'workflows');
  const workflowFileNames = readdirSync(workflowsDirectory)
    .filter((fileName) => /\.ya?ml$/.test(fileName))
    .sort();
  return workflowFileNames.flatMap((fileName) => {
    const workflowText = readFileSync(join(workflowsDirectory, fileName), 'utf8');
    return findUnpinnedActions(workflowText).map(
      ({ lineNumber, reference }) => `.github/workflows/${fileName}:${lineNumber}: ${reference}`,
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
