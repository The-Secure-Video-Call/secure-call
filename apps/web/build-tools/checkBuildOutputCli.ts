// Usage (from apps/web, after `pnpm build`): node build-tools/checkBuildOutputCli.ts dist
// Plain Node runs this file directly (type stripping, Node 22.18 or newer).
import { checkBuildOutput } from './checkBuildOutput.ts';

const buildFolderPath = process.argv[2];
if (buildFolderPath === undefined) {
  console.error('Usage: node checkBuildOutputCli.ts <build folder>');
  process.exit(2);
}

const problems = await checkBuildOutput(buildFolderPath);
if (problems.length > 0) {
  console.error(`Build check failed with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  'Build check passed: index.html has no inline code, SRI hashes match, headers are intact.',
);
