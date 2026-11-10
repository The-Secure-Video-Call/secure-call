import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBuildOutput } from './checkBuildOutput.ts';
import { computeIntegrityAttributeValue } from './subresourceIntegrityHash.ts';

const realHtaccessUrl = new URL('../public/.htaccess', import.meta.url);
const temporaryFolders: string[] = [];

async function createBuildFolder(scriptText: string, integrityScriptText: string) {
  const buildFolder = mkdtempSync(join(tmpdir(), 'secure-call-build-'));
  temporaryFolders.push(buildFolder);
  mkdirSync(join(buildFolder, 'assets'));
  writeFileSync(join(buildFolder, 'assets', 'index-abc.js'), scriptText);
  const integrity = await computeIntegrityAttributeValue(
    new TextEncoder().encode(integrityScriptText),
  );
  writeFileSync(
    join(buildFolder, 'index.html'),
    `<html><head><script type="module" crossorigin src="/assets/index-abc.js" integrity="${integrity}"></script></head><body></body></html>`,
  );
  copyFileSync(realHtaccessUrl, join(buildFolder, '.htaccess'));
  return buildFolder;
}

afterEach(() => {
  for (const folder of temporaryFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('checkBuildOutput', () => {
  it('passes for a consistent build folder', async () => {
    expect(await checkBuildOutput(await createBuildFolder('a()', 'a()'))).toEqual([]);
  });

  it('fails when the script was changed after hashing', async () => {
    const problems = await checkBuildOutput(await createBuildFolder('evil()', 'a()'));
    expect(problems.join()).toContain('does not match');
  });

  it('fails when index.html or .htaccess is missing', async () => {
    const emptyFolder = mkdtempSync(join(tmpdir(), 'secure-call-empty-'));
    temporaryFolders.push(emptyFolder);
    const problems = await checkBuildOutput(emptyFolder);
    expect(problems).toHaveLength(2);
  });

  it('does not read files outside the build folder', async () => {
    const buildFolder = await createBuildFolder('a()', 'a()');
    writeFileSync(
      join(buildFolder, 'index.html'),
      '<script crossorigin integrity="sha384-x" src="/../../etc/passwd"></script>',
    );
    const problems = await checkBuildOutput(buildFolder);
    expect(problems.join()).toContain('not a same-origin absolute path');
  });
});
