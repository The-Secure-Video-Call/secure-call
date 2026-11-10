// Build check for dist/index.html: no inline code, and every script and stylesheet carries an
// integrity hash that matches the built file. Returns a list of problems (empty = fine).
import {
  findStartTags,
  isIntegrityProtectedTag,
  readResourceUrl,
  toBuildFilePath,
} from './htmlResourceTags.ts';
import {
  computeIntegrityAttributeValue,
  type IntegrityAlgorithm,
} from './subresourceIntegrityHash.ts';
import type { BuiltFileReader } from './subresourceIntegrityPlugin.ts';

const STRONG_ALGORITHMS: IntegrityAlgorithm[] = ['sha384', 'sha512'];

async function checkIntegrityAttribute(
  integrityText: string,
  builtFileBytes: Uint8Array,
  resourceUrl: string,
): Promise<string[]> {
  const integrityTokens = integrityText.split(/\s+/).filter(Boolean);
  if (integrityTokens.length === 0) return [`${resourceUrl}: integrity attribute is empty`];
  const problems: string[] = [];
  for (const integrityToken of integrityTokens) {
    const algorithm = integrityToken.split('-', 1)[0] as IntegrityAlgorithm;
    if (!STRONG_ALGORITHMS.includes(algorithm)) {
      problems.push(`${resourceUrl}: integrity must use sha384 or sha512, got "${integrityToken}"`);
      continue;
    }
    const expectedToken = await computeIntegrityAttributeValue(builtFileBytes, algorithm);
    if (integrityToken !== expectedToken) {
      problems.push(`${resourceUrl}: integrity hash does not match the built file`);
    }
  }
  return problems;
}

export async function checkIndexHtml(
  html: string,
  readBuiltFile: BuiltFileReader,
): Promise<string[]> {
  const problems: string[] = [];
  for (const startTag of findStartTags(html)) {
    if (startTag.tagName === 'style') problems.push('inline <style> element');
    if (startTag.tagName === 'script' && !startTag.attributes.has('src')) {
      problems.push('inline <script> (no src)');
    }
    for (const [attributeName, attributeValue] of startTag.attributes) {
      if (attributeName.startsWith('on')) {
        problems.push(`inline event handler "${attributeName}" on <${startTag.tagName}>`);
      }
      if (attributeName === 'style')
        problems.push(`inline style attribute on <${startTag.tagName}>`);
      if (/^\s*(javascript|data|vbscript):/i.test(attributeValue) && attributeName !== 'src') {
        problems.push(`"${attributeName}" on <${startTag.tagName}> starts with a script address`);
      }
    }
    if (!isIntegrityProtectedTag(startTag)) continue;

    const resourceUrl = readResourceUrl(startTag);
    if (resourceUrl === undefined) continue; // an inline script, already reported above
    const buildFilePath = toBuildFilePath(resourceUrl);
    if (buildFilePath === undefined) {
      problems.push(`${resourceUrl}: not a same-origin absolute path`);
      continue;
    }
    if (!startTag.attributes.has('crossorigin')) problems.push(`${resourceUrl}: no crossorigin`);
    const integrityText = startTag.attributes.get('integrity');
    if (integrityText === undefined) {
      problems.push(`${resourceUrl}: no integrity attribute`);
      continue;
    }
    const builtFileBytes = readBuiltFile(buildFilePath);
    if (builtFileBytes === undefined) {
      problems.push(`${resourceUrl}: file is not in the build output`);
      continue;
    }
    problems.push(...(await checkIntegrityAttribute(integrityText, builtFileBytes, resourceUrl)));
  }
  return problems;
}
