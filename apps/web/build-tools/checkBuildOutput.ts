// Runs both build checks on a build folder (dist/): index.html and .htaccess.
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { checkIndexHtml } from './indexHtmlCheck.ts';
import { checkSecurityHeaders } from './securityHeadersCheck.ts';

/** Returns every problem found in the build folder (empty = fine). */
export async function checkBuildOutput(buildFolderPath: string): Promise<string[]> {
  const absoluteBuildFolder = resolve(buildFolderPath);
  const indexHtmlPath = resolve(absoluteBuildFolder, 'index.html');
  const htaccessPath = resolve(absoluteBuildFolder, '.htaccess');
  const problems: string[] = [];
  if (!existsSync(indexHtmlPath)) problems.push('index.html: not found in the build folder');
  if (!existsSync(htaccessPath)) problems.push('.htaccess: not found in the build folder');
  if (problems.length > 0) return problems;

  const readBuiltFile = (buildFilePath: string): Uint8Array | undefined => {
    const absoluteFilePath = resolve(absoluteBuildFolder, buildFilePath);
    if (!absoluteFilePath.startsWith(absoluteBuildFolder + sep)) return undefined;
    return existsSync(absoluteFilePath) ? readFileSync(absoluteFilePath) : undefined;
  };

  const indexHtmlProblems = await checkIndexHtml(
    readFileSync(indexHtmlPath, 'utf8'),
    readBuiltFile,
  );
  const headerProblems = checkSecurityHeaders(readFileSync(htaccessPath, 'utf8'));
  return [
    ...indexHtmlProblems.map((problem) => `index.html: ${problem}`),
    ...headerProblems.map((problem) => `.htaccess: ${problem}`),
  ];
}
