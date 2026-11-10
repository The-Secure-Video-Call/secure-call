import { describe, expect, it } from 'vitest';
import { checkIndexHtml } from './indexHtmlCheck.ts';
import { computeIntegrityAttributeValue } from './subresourceIntegrityHash.ts';
import type { BuiltFileReader } from './subresourceIntegrityPlugin.ts';

const scriptBytes = new TextEncoder().encode('console.log(1)');
const styleBytes = new TextEncoder().encode('body{margin:0}');
const builtFiles = new Map<string, Uint8Array>([
  ['assets/index-abc.js', scriptBytes],
  ['assets/index-abc.css', styleBytes],
]);
const readBuiltFile: BuiltFileReader = (buildFilePath) => builtFiles.get(buildFilePath);

const scriptIntegrity = await computeIntegrityAttributeValue(scriptBytes);
const styleIntegrity = await computeIntegrityAttributeValue(styleBytes);

function buildHtml(options: { scriptTag?: string; extraHead?: string; bodyAttributes?: string }) {
  const scriptTag =
    options.scriptTag ??
    `<script type="module" crossorigin src="/assets/index-abc.js" integrity="${scriptIntegrity}"></script>`;
  return (
    '<!doctype html><html><head>' +
    scriptTag +
    `<link rel="stylesheet" crossorigin href="/assets/index-abc.css" integrity="${styleIntegrity}">` +
    (options.extraHead ?? '') +
    `</head><body ${options.bodyAttributes ?? ''}><div id="root"></div></body></html>`
  );
}

describe('checkIndexHtml', () => {
  it('accepts a correct page', async () => {
    expect(await checkIndexHtml(buildHtml({}), readBuiltFile)).toEqual([]);
  });

  it('rejects an inline script', async () => {
    const problems = await checkIndexHtml(
      buildHtml({ extraHead: '<script>alert(1)</script>' }),
      readBuiltFile,
    );
    expect(problems.join()).toMatch(/inline <script>/);
  });

  it('rejects an onclick attribute', async () => {
    const problems = await checkIndexHtml(
      buildHtml({ bodyAttributes: 'onclick="alert(1)"' }),
      readBuiltFile,
    );
    expect(problems.join()).toMatch(/event handler "onclick"/);
  });

  it('rejects a script without integrity', async () => {
    const problems = await checkIndexHtml(
      buildHtml({
        scriptTag: '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
      }),
      readBuiltFile,
    );
    expect(problems.join()).toMatch(/no integrity/);
  });

  it('rejects a wrong hash', async () => {
    const wrongIntegrity = await computeIntegrityAttributeValue(new TextEncoder().encode('evil'));
    const problems = await checkIndexHtml(
      buildHtml({
        scriptTag: `<script type="module" crossorigin src="/assets/index-abc.js" integrity="${wrongIntegrity}"></script>`,
      }),
      readBuiltFile,
    );
    expect(problems.join()).toMatch(/does not match/);
  });

  it('rejects a weak algorithm and a missing crossorigin', async () => {
    const sha256Integrity = await computeIntegrityAttributeValue(scriptBytes, 'sha256');
    const problems = await checkIndexHtml(
      buildHtml({
        scriptTag: `<script src="/assets/index-abc.js" integrity="${sha256Integrity}"></script>`,
      }),
      readBuiltFile,
    );
    expect(problems.join()).toMatch(/sha384 or sha512/);
    expect(problems.join()).toMatch(/no crossorigin/);
  });

  it('rejects an off-origin script, an inline style and a javascript: link', async () => {
    const offOrigin = await checkIndexHtml(
      buildHtml({
        scriptTag:
          '<script src="https://cdn.example/a.js" integrity="sha384-x" crossorigin></script>',
      }),
      readBuiltFile,
    );
    expect(offOrigin.join()).toMatch(/same-origin/);
    const inlineStyle = await checkIndexHtml(
      buildHtml({ extraHead: '<style>a{}</style>', bodyAttributes: 'style="color:red"' }),
      readBuiltFile,
    );
    expect(inlineStyle.join()).toMatch(/inline <style>/);
    expect(inlineStyle.join()).toMatch(/inline style attribute/);
    const scriptAddress = await checkIndexHtml(
      buildHtml({ extraHead: '<a href="javascript:alert(1)">x</a>' }),
      readBuiltFile,
    );
    expect(scriptAddress.join()).toMatch(/script address/);
  });

  it('rejects a file that is missing from the build', async () => {
    const problems = await checkIndexHtml(buildHtml({}), () => undefined);
    expect(problems.join()).toMatch(/not in the build output/);
  });

  it('does not let <!--> hide a script from the check', async () => {
    const html = buildHtml({ extraHead: '<!--> <script>alert(1)</script> -->' });
    expect((await checkIndexHtml(html, readBuiltFile)).join()).toMatch(/inline <script>/);
  });

  it('rejects meta refresh, preconnect, base and a obfuscated javascript: address', async () => {
    const extraHeads = [
      '<meta http-equiv="refresh" content="0;url=https://x.example">',
      '<link rel="preconnect" href="https://x.example">',
      '<base href="https://x.example/">',
      '<a href="java\tscript:alert(1)">x</a>',
    ];
    for (const extraHead of extraHeads) {
      const problems = await checkIndexHtml(buildHtml({ extraHead }), readBuiltFile);
      expect(problems.length, extraHead).toBeGreaterThan(0);
    }
  });

  it('ignores markup inside HTML comments', async () => {
    const html = buildHtml({ extraHead: '<!-- <script>alert(1)</script> -->' });
    expect(await checkIndexHtml(html, readBuiltFile)).toEqual([]);
  });
});
