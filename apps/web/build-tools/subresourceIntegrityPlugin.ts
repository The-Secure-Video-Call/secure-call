// Vite plugin: adds integrity="sha384-..." and crossorigin to every <script> and every
// <link rel="stylesheet|modulepreload|preload"> in the built index.html. No dependency:
// the hash comes from the Web Crypto API.
import type { Plugin } from 'vite';
import {
  findStartTags,
  isIntegrityProtectedTag,
  readResourceUrl,
  toBuildFilePath,
} from './htmlResourceTags.ts';
import { computeIntegrityAttributeValue } from './subresourceIntegrityHash.ts';

/** Returns the bytes of a built file given its path inside the build folder, or undefined. */
export type BuiltFileReader = (buildFilePath: string) => Uint8Array | undefined;

/**
 * Returns the HTML with `integrity` and `crossorigin` added to every protected tag.
 * Throws (so the build fails) for an inline script, an address that is not a same-origin path,
 * a file that is not in the build, or a tag that already has an `integrity`.
 */
export async function addSubresourceIntegrity(
  html: string,
  readBuiltFile: BuiltFileReader,
): Promise<string> {
  const protectedTags = findStartTags(html).filter(isIntegrityProtectedTag);
  let htmlWithIntegrity = html;
  // Last tag first, so the indexes of the earlier tags stay valid.
  for (const protectedTag of protectedTags.reverse()) {
    const resourceUrl = readResourceUrl(protectedTag);
    if (resourceUrl === undefined) {
      throw new Error(
        `SRI: inline or address-less <${protectedTag.tagName}>: ${protectedTag.rawTagText}`,
      );
    }
    const buildFilePath = toBuildFilePath(resourceUrl);
    if (buildFilePath === undefined) {
      throw new Error(`SRI: "${resourceUrl}" is not a same-origin absolute path`);
    }
    if (protectedTag.attributes.has('integrity')) {
      throw new Error(`SRI: "${resourceUrl}" already has an integrity attribute`);
    }
    const builtFileBytes = readBuiltFile(buildFilePath);
    if (builtFileBytes === undefined) {
      throw new Error(`SRI: "${buildFilePath}" is not in the build output`);
    }
    const integrityValue = await computeIntegrityAttributeValue(builtFileBytes, 'sha384');
    const crossoriginText = protectedTag.attributes.has('crossorigin') ? '' : ' crossorigin';
    const tagEnding = /\s*\/?>$/.exec(protectedTag.rawTagText)?.[0] ?? '>';
    const tagWithoutEnding = protectedTag.rawTagText.slice(0, -tagEnding.length);
    const newTagText = `${tagWithoutEnding}${crossoriginText} integrity="${integrityValue}"${tagEnding}`;
    htmlWithIntegrity =
      htmlWithIntegrity.slice(0, protectedTag.startIndex) +
      newTagText +
      htmlWithIntegrity.slice(protectedTag.endIndex);
  }
  return htmlWithIntegrity;
}

export function subresourceIntegrityPlugin(): Plugin {
  return {
    name: 'secure-call-subresource-integrity',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      async handler(html, context) {
        const outputBundle = context.bundle;
        if (outputBundle === undefined) {
          throw new Error('SRI: Vite gave the plugin no build output, so nothing can be hashed');
        }
        const textEncoder = new TextEncoder();
        const readBuiltFile: BuiltFileReader = (buildFilePath) => {
          const outputFile = outputBundle[buildFilePath];
          if (outputFile === undefined) return undefined;
          const fileContent = outputFile.type === 'chunk' ? outputFile.code : outputFile.source;
          return typeof fileContent === 'string' ? textEncoder.encode(fileContent) : fileContent;
        };
        return addSubresourceIntegrity(html, readBuiltFile);
      },
    },
  };
}
