import { describe, expect, it } from 'vitest';
import { addSubresourceIntegrity, type BuiltFileReader } from './subresourceIntegrityPlugin.ts';
import { computeIntegrityAttributeValue } from './subresourceIntegrityHash.ts';

const scriptBytes = new TextEncoder().encode('console.log(1)');
const styleBytes = new TextEncoder().encode('body{margin:0}');
const builtFiles = new Map<string, Uint8Array>([
  ['assets/index-abc.js', scriptBytes],
  ['assets/index-abc.css', styleBytes],
]);
const readBuiltFile: BuiltFileReader = (buildFilePath) => builtFiles.get(buildFilePath);

const viteOutputHtml =
  '<html><head>' +
  '<script type="module" crossorigin src="/assets/index-abc.js"></script>' +
  '<link rel="stylesheet" crossorigin href="/assets/index-abc.css">' +
  '</head><body></body></html>';

describe('addSubresourceIntegrity', () => {
  it('adds a correct sha384 integrity to the script and the stylesheet', async () => {
    const html = await addSubresourceIntegrity(viteOutputHtml, readBuiltFile);
    const scriptIntegrity = await computeIntegrityAttributeValue(scriptBytes);
    const styleIntegrity = await computeIntegrityAttributeValue(styleBytes);
    expect(html).toContain(`src="/assets/index-abc.js" integrity="${scriptIntegrity}"></script>`);
    expect(html).toContain(`href="/assets/index-abc.css" integrity="${styleIntegrity}">`);
  });

  it('adds crossorigin when it is missing and does not repeat it', async () => {
    const html = await addSubresourceIntegrity(
      '<script src="/assets/index-abc.js"></script>',
      readBuiltFile,
    );
    expect(html).toMatch(/<script src="\/assets\/index-abc\.js" crossorigin integrity="sha384-/);
    const htmlWithCrossorigin = await addSubresourceIntegrity(viteOutputHtml, readBuiltFile);
    expect(htmlWithCrossorigin.match(/crossorigin/g)).toHaveLength(2);
  });

  it('handles a self-closing link tag', async () => {
    const html = await addSubresourceIntegrity(
      '<link rel="modulepreload" href="/assets/index-abc.js" />',
      readBuiltFile,
    );
    expect(html).toMatch(/crossorigin integrity="sha384-[^"]+" \/>$/);
  });

  it('leaves other link tags such as icons alone', async () => {
    const iconHtml = '<link rel="icon" href="/favicon.svg">';
    expect(await addSubresourceIntegrity(iconHtml, readBuiltFile)).toBe(iconHtml);
  });

  it('fails the build for an inline script', async () => {
    await expect(
      addSubresourceIntegrity('<script>alert(1)</script>', readBuiltFile),
    ).rejects.toThrow(/inline/);
  });

  it('fails the build for an off-origin script', async () => {
    await expect(
      addSubresourceIntegrity('<script src="https://cdn.example/a.js"></script>', readBuiltFile),
    ).rejects.toThrow(/same-origin/);
    await expect(
      addSubresourceIntegrity('<script src="//cdn.example/a.js"></script>', readBuiltFile),
    ).rejects.toThrow(/same-origin/);
  });

  it('fails the build for a file that is not in the build output', async () => {
    await expect(
      addSubresourceIntegrity('<script src="/assets/missing.js"></script>', readBuiltFile),
    ).rejects.toThrow(/not in the build output/);
  });

  it('fails the build when a tag already has an integrity attribute', async () => {
    await expect(
      addSubresourceIntegrity(
        '<script src="/assets/index-abc.js" integrity="sha384-x"></script>',
        readBuiltFile,
      ),
    ).rejects.toThrow(/already has/);
  });
});
