// Checks that the live site serves exactly a published release of this repository.
//
// Every deploy publishes a GitHub Release "web-<commit>" with SHA256SUMS of the files it
// uploaded (deploy-web.yml). This script downloads the newest one (or the one named with
// --release), then fetches the live site and checks that:
//   - index.html and every file under assets/ hash exactly as listed;
//   - index.html loads nothing that is not in the release (a script added by a host fails);
//   - the security headers equal the ones apps/web/public/.htaccess sets at the release's commit
//     (.htaccess itself is not served, so its headers are compared instead of its hash).
// Anyone can run it; it needs Node 22+ and nothing else:
//   node scripts/verify-deployed.mjs [--release web-<commit>] [--site https://securevideocall.com]
// or, against your own rebuild of a commit (see README):
//   node scripts/verify-deployed.mjs --sums SHA256SUMS --commit <40-character commit>
// It checks what this one request saw: a compromised host could serve other files to other
// people. Exits 0 when everything matches, 1 otherwise (any fetch error included).
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';

const REPOSITORY = 'The-Secure-Video-Call/secure-call';
const DEFAULT_SITE = 'https://securevideocall.com';
const RELEASE_TAG_PATTERN = /^web-[0-9a-f]{12}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CHECKSUM_LINE = /^(?<hash>[0-9a-f]{64}) {2}(?:\.\/)?(?<path>[A-Za-z0-9_./-]+)$/;
const ASSET_PATH = /^assets\/[A-Za-z0-9_-]+\.[a-z0-9]+$/;

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** SHA256SUMS ("<hash>  <path>" per line) as a Map from path to hash. Malformed lines throw. */
export function parseChecksums(checksumsText) {
  const hashesByPath = new Map();
  for (const line of checksumsText.split('\n')) {
    if (line.trim() === '') continue;
    const match = CHECKSUM_LINE.exec(line);
    const path = match?.groups?.path;
    if (!match || !path || path.includes('..')) throw new Error(`bad SHA256SUMS line: ${line}`);
    hashesByPath.set(path, match.groups.hash);
  }
  if (!hashesByPath.has('index.html')) throw new Error('SHA256SUMS lists no index.html');
  return hashesByPath;
}

/** The headers set for every response by .htaccess (top-level `Header always set`). */
export function readAlwaysSetHeaders(htaccessText) {
  const headers = new Map();
  let sectionDepth = 0;
  for (const rawLine of htaccessText.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('</')) {
      sectionDepth = Math.max(0, sectionDepth - 1);
      continue;
    }
    if (line.startsWith('<')) {
      sectionDepth += 1;
      continue;
    }
    const match = /^Header\s+always\s+set\s+(\S+)\s+"([^"]*)"$/i.exec(line);
    if (match && sectionDepth === 0) headers.set(match[1].toLowerCase(), match[2]);
  }
  return headers;
}

/** Every same-site path index.html loads (src/href), or a problem for anything off-site. */
export function readReferencedPaths(indexHtml) {
  const paths = [];
  const problems = [];
  for (const match of indexHtml.matchAll(/\s(?:src|href)\s*=\s*["']([^"']*)["']/gi)) {
    const reference = match[1];
    if (reference.startsWith('/') && !reference.startsWith('//')) paths.push(reference.slice(1));
    else problems.push(`index.html loads something off-site: ${reference}`);
  }
  return { paths, problems };
}

/**
 * Compares the live site with one release. `fetchBytes(url)` returns { bytes, headers } and
 * throws on any failure. Returns the problems found (empty = the site matches) and what passed.
 */
export async function verifySite({ siteUrl, hashesByPath, expectedHeaders, fetchBytes }) {
  const problems = [];
  const passed = [];
  const index = await fetchBytes(new URL('/', siteUrl).href);
  if (sha256Hex(index.bytes) === hashesByPath.get('index.html')) passed.push('index.html');
  else problems.push('index.html differs from the release');

  for (const [headerName, expectedValue] of expectedHeaders) {
    const liveValue = index.headers.get(headerName);
    if (liveValue === expectedValue) passed.push(`header ${headerName}`);
    else
      problems.push(
        `header ${headerName} is ${JSON.stringify(liveValue)}, expected ${JSON.stringify(expectedValue)}`,
      );
  }

  const references = readReferencedPaths(new TextDecoder().decode(index.bytes));
  problems.push(...references.problems);
  for (const path of references.paths) {
    if (!hashesByPath.has(path))
      problems.push(`index.html loads ${path}, which is not in the release`);
  }

  for (const [path, expectedHash] of hashesByPath) {
    if (path === 'index.html' || path === '.htaccess') continue;
    if (!ASSET_PATH.test(path)) {
      problems.push(`unexpected file in the release: ${path}`);
      continue;
    }
    const asset = await fetchBytes(new URL(`/${path}`, siteUrl).href);
    if (sha256Hex(asset.bytes) === expectedHash) passed.push(path);
    else problems.push(`${path} differs from the release`);
  }
  return { problems, passed };
}

function readOption(commandLineArguments, name) {
  const index = commandLineArguments.indexOf(name);
  return index === -1 ? undefined : commandLineArguments[index + 1];
}

async function fetchOk(fetchFunction, url, options = {}) {
  const response = await fetchFunction(url, { cache: 'no-store', ...options });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

/** The release to check: the named one, or the newest web-<commit> release. */
async function findRelease(fetchFunction, releaseTag) {
  const apiUrl = releaseTag
    ? `https://api.github.com/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(releaseTag)}`
    : `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`;
  const answer = await (
    await fetchOk(fetchFunction, apiUrl, { headers: { accept: 'application/vnd.github+json' } })
  ).json();
  const release = releaseTag
    ? answer
    : answer.find((candidate) => !candidate.draft && RELEASE_TAG_PATTERN.test(candidate.tag_name));
  if (!release || !RELEASE_TAG_PATTERN.test(release.tag_name))
    throw new Error('no web-<commit> release found');
  if (!COMMIT_PATTERN.test(release.target_commitish))
    throw new Error(`${release.tag_name} names no commit`);
  const checksumsAsset = release.assets.find((asset) => asset.name === 'SHA256SUMS');
  if (!checksumsAsset) throw new Error(`${release.tag_name} has no SHA256SUMS`);
  return {
    tag: release.tag_name,
    commit: release.target_commitish,
    checksumsUrl: checksumsAsset.browser_download_url,
  };
}

export async function main(
  commandLineArguments,
  { fetchFunction = fetch, log = console.log } = {},
) {
  try {
    const siteUrl = readOption(commandLineArguments, '--site') ?? DEFAULT_SITE;
    if (!/^https:\/\//.test(siteUrl)) throw new Error('--site must be an https:// URL');
    // --sums FILE --commit SHA: your own rebuild instead of a published release (README).
    const localChecksumsPath = readOption(commandLineArguments, '--sums');
    let release;
    let checksumsText;
    if (localChecksumsPath) {
      const commit = readOption(commandLineArguments, '--commit') ?? '';
      if (!COMMIT_PATTERN.test(commit))
        throw new Error('--sums needs --commit <40-character commit>');
      release = { tag: `local ${localChecksumsPath}`, commit };
      checksumsText = readFileSync(localChecksumsPath, 'utf8');
    } else {
      release = await findRelease(fetchFunction, readOption(commandLineArguments, '--release'));
      checksumsText = await (await fetchOk(fetchFunction, release.checksumsUrl)).text();
    }
    const hashesByPath = parseChecksums(checksumsText);
    const htaccessUrl = `https://raw.githubusercontent.com/${REPOSITORY}/${release.commit}/apps/web/public/.htaccess`;
    const expectedHeaders = readAlwaysSetHeaders(
      await (await fetchOk(fetchFunction, htaccessUrl)).text(),
    );
    if (expectedHeaders.size === 0)
      throw new Error('the release commit sets no headers in .htaccess');

    // The site must answer directly: a redirect to another host must not count as "the site".
    const fetchBytes = async (url) => {
      const response = await fetchOk(fetchFunction, url, { redirect: 'error' });
      return { bytes: new Uint8Array(await response.arrayBuffer()), headers: response.headers };
    };
    const { problems, passed } = await verifySite({
      siteUrl,
      hashesByPath,
      expectedHeaders,
      fetchBytes,
    });
    log(`Release ${release.tag} (commit ${release.commit}) against ${siteUrl}:`);
    for (const item of passed) log(`  OK       ${item}`);
    for (const problem of problems) log(`  MISMATCH ${problem}`);
    if (problems.length > 0) {
      log(`${problems.length} problem(s): the live site is NOT this release.`);
      return 1;
    }
    log('The live site serves exactly this release, with its security headers.');
    return 0;
  } catch (error) {
    log(`Could not verify: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Run as a script (also through a symlinked path: compare real paths, never fail open).
const invokedPath = process.argv[1] === undefined ? '' : realpathSync(process.argv[1]);
if (invokedPath === realpathSync(new URL(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
