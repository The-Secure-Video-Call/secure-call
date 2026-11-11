// Checks that the live site serves exactly a published release of this repository.
//
// Every deploy publishes a GitHub Release "web-<commit>" with SHA256SUMS of the files it
// uploaded, attested as made by deploy-web.yml on main. This script takes the newest one (or the
// one named with --release), checks that its tag, commit and hashes belong together, that the
// commit is on main and (with the GitHub CLI, gh) that the attestation names that workflow, main
// and that commit, and the same for the release's SBOM (sbom.cdx.json; only releases of commits
// from before SBOMs may lack one, which is reported), then fetches the live site and checks that:
//   - index.html and every file under assets/ hash exactly as listed;
//   - index.html loads nothing that is not in the release (a script added by a host fails);
//   - every response carries the security headers apps/web/public/.htaccess sets at the
//     release's commit (whose own hash must match SHA256SUMS; .htaccess itself is not served),
//     index.html is never cached as immutable, and no response redirects with Refresh.
// Anyone can run it; it needs Node 22+ and gh (signed in) for the attestation:
//   node scripts/verify-deployed.mjs [--release web-<commit>] [--site https://securevideocall.com]
//   node scripts/verify-deployed.mjs --skip-provenance   # without gh: files and headers only
// or, against your own rebuild of a commit (see SECURITY.md):
//   node scripts/verify-deployed.mjs --sums SHA256SUMS --commit <40-character commit>
// It checks what this one request saw: a compromised host could serve other files to other
// people. Exits 0 when everything matches, 1 otherwise (any fetch error included).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPOSITORY = 'The-Secure-Video-Call/secure-call';
const DEFAULT_SITE = 'https://securevideocall.com';
const RELEASE_TAG_PATTERN = /^web-[0-9a-f]{12}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CHECKSUM_LINE = /^(?<hash>[0-9a-f]{64}) {2}(?:\.\/)?(?<path>[A-Za-z0-9_./-]+)$/;
const ASSET_PATH = /^assets\/[A-Za-z0-9_-]+\.[a-z0-9]+$/;
const OPTION_NAMES = new Set(['--release', '--site', '--sums', '--commit']);
const FLAG_NAMES = new Set(['--skip-provenance']);
const SIGNER_WORKFLOW = `${REPOSITORY}/.github/workflows/deploy-web.yml`;
const SBOM_NAME = 'sbom.cdx.json';
// The headers .htaccess sets on every response today (PLAN.md 3.5). A release commit whose
// .htaccess sets fewer is refused, so a reformatted or truncated file can never drop one from
// the comparison without anyone noticing.
const REQUIRED_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'x-frame-options',
];

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Text safe to print: everything outside printable ASCII becomes \uXXXX. Paths and headers come
 * from the site being checked, and a hostile site must not be able to send terminal escapes or
 * line breaks that overwrite a MISMATCH line with a fake OK.
 */
export function printable(text) {
  return text.replace(
    /[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** SHA256SUMS ("<hash>  <path>" per line) as a Map from path to hash. Anything odd throws. */
export function parseChecksums(checksumsText) {
  const hashesByPath = new Map();
  for (const line of checksumsText.split('\n')) {
    if (line.trim() === '') continue;
    const { hash, path } = CHECKSUM_LINE.exec(line)?.groups ?? {};
    // No empty, "." or ".." parts and no other dotfiles: only .htaccess, index.html, assets/...
    const isSafePath =
      path === '.htaccess' ||
      (path !== undefined && path.split('/').every((part) => part !== '' && !part.startsWith('.')));
    if (hash === undefined || !isSafePath)
      throw new Error(`bad SHA256SUMS line: ${JSON.stringify(line)}`);
    if (hashesByPath.has(path)) throw new Error(`SHA256SUMS lists ${path} twice`);
    hashesByPath.set(path, hash);
  }
  if (!hashesByPath.has('index.html')) throw new Error('SHA256SUMS lists no index.html');
  if (!hashesByPath.has('.htaccess')) throw new Error('SHA256SUMS lists no .htaccess');
  return hashesByPath;
}

/** The number of components in a CycloneDX JSON SBOM. Anything else throws. */
export function countSbomComponents(sbomText) {
  let sbom;
  try {
    sbom = JSON.parse(sbomText);
  } catch {
    throw new Error(`${SBOM_NAME} is not JSON`);
  }
  if (sbom?.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components))
    throw new Error(`${SBOM_NAME} is not a CycloneDX SBOM`);
  return sbom.components.length;
}

/**
 * The headers .htaccess sets for every response: its top-level `Header always set` lines.
 * Fails closed: a line continuation, any other top-level Header line, a header set twice or a
 * required header missing throws, instead of quietly checking fewer headers.
 */
export function readAlwaysSetHeaders(htaccessText) {
  const headers = new Map();
  let sectionDepth = 0;
  for (const rawLine of htaccessText.split('\n')) {
    if (/\\\s*$/.test(rawLine)) throw new Error('.htaccess uses a line continuation');
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
    if (sectionDepth > 0 || !/^Header\s/i.test(line)) continue;
    const match = /^Header\s+always\s+set\s+([A-Za-z0-9-]+)\s+"([^"\\]*)"$/i.exec(line);
    if (!match) throw new Error(`cannot read this .htaccess line: ${JSON.stringify(line)}`);
    const headerName = match[1].toLowerCase();
    if (headers.has(headerName)) throw new Error(`.htaccess sets ${headerName} twice`);
    headers.set(headerName, match[2]);
  }
  const missing = REQUIRED_HEADERS.filter((headerName) => !headers.has(headerName));
  if (missing.length > 0) throw new Error(`.htaccess does not set ${missing.join(', ')}`);
  return headers;
}

/**
 * Every same-site path index.html loads, or a problem for anything else. A simple scan, not an
 * HTML parser: index.html is pinned by its hash anyway, so this is a second, readable check.
 */
export function readReferencedPaths(indexHtml) {
  const paths = [];
  const problems = [];
  const attributePattern = /[\s/](?:src|href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  for (const match of indexHtml.matchAll(attributePattern)) {
    const reference = match[1] ?? match[2] ?? match[3] ?? '';
    if (/^\/[A-Za-z0-9_./-]+$/.test(reference) && !reference.startsWith('//'))
      paths.push(reference.slice(1));
    else problems.push(`index.html loads something off-site: ${JSON.stringify(reference)}`);
  }
  if (/http-equiv\s*=\s*["']?refresh/i.test(indexHtml))
    problems.push('index.html has a meta refresh');
  return { paths, problems };
}

/** Problems with one response's headers: each expected header exactly, and no Refresh. */
function checkResponseHeaders(label, headers, expectedHeaders) {
  const problems = [];
  for (const [headerName, expectedValue] of expectedHeaders) {
    const liveValue = headers.get(headerName);
    if (liveValue !== expectedValue)
      problems.push(
        `${label}: header ${headerName} is ${liveValue === null ? 'missing' : JSON.stringify(liveValue)}, expected ${JSON.stringify(expectedValue)}`,
      );
  }
  if (headers.get('refresh') !== null) problems.push(`${label}: has a Refresh header`);
  return problems;
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

  const indexHeaderProblems = checkResponseHeaders('index.html', index.headers, expectedHeaders);
  problems.push(...indexHeaderProblems);
  if (indexHeaderProblems.length === 0)
    passed.push(...[...expectedHeaders.keys()].map((headerName) => `header ${headerName}`));
  // index.html must be revalidated: a host must not hand someone a copy cached for a year.
  const cacheDirectives = (index.headers.get('cache-control') ?? '')
    .split(',')
    .map((directive) => directive.trim().toLowerCase());
  const isRevalidated =
    cacheDirectives.includes('no-cache') || cacheDirectives.includes('no-store');
  if (isRevalidated && !cacheDirectives.includes('immutable')) passed.push('index.html caching');
  else
    problems.push(
      `index.html: Cache-Control ${JSON.stringify(index.headers.get('cache-control'))} lets browsers keep it`,
    );

  const references = readReferencedPaths(new TextDecoder().decode(index.bytes));
  problems.push(...references.problems);
  for (const path of references.paths) {
    if (!hashesByPath.has(path))
      problems.push(`index.html loads ${JSON.stringify(path)}, which is not in the release`);
  }

  for (const [path, expectedHash] of hashesByPath) {
    if (path === 'index.html' || path === '.htaccess') continue;
    if (!ASSET_PATH.test(path)) {
      problems.push(`unexpected file in the release: ${path}`);
      continue;
    }
    const asset = await fetchBytes(new URL(`/${path}`, siteUrl).href);
    const assetProblems = checkResponseHeaders(path, asset.headers, expectedHeaders);
    if (sha256Hex(asset.bytes) !== expectedHash)
      assetProblems.push(`${path} differs from the release`);
    if (assetProblems.length === 0) passed.push(path);
    problems.push(...assetProblems);
  }
  return { problems, passed };
}

/**
 * The command line as { '--release': value, '--skip-provenance': true, ... }. Anything unknown,
 * repeated or empty throws.
 */
export function readOptions(commandLineArguments) {
  const options = {};
  for (let index = 0; index < commandLineArguments.length; index += 1) {
    const name = commandLineArguments[index];
    if (name in options) throw new Error(`${name} given twice`);
    if (FLAG_NAMES.has(name)) {
      options[name] = true;
      continue;
    }
    if (!OPTION_NAMES.has(name)) throw new Error(`unknown argument ${JSON.stringify(name)}`);
    index += 1;
    const value = commandLineArguments[index];
    if (value === undefined || value === '' || value.startsWith('--'))
      throw new Error(`${name} needs a value`);
    options[name] = value;
  }
  if ('--sums' in options && '--skip-provenance' in options)
    throw new Error('--skip-provenance is for published releases, not --sums');
  if ('--sums' in options !== '--commit' in options)
    throw new Error('--sums and --commit go together');
  if ('--sums' in options && '--release' in options)
    throw new Error('--sums and --release exclude each other');
  if ('--release' in options && !RELEASE_TAG_PATTERN.test(options['--release']))
    throw new Error('--release must be web-<first 12 characters of the commit>');
  if ('--commit' in options && !COMMIT_PATTERN.test(options['--commit']))
    throw new Error('--commit must be a 40-character commit');
  return options;
}

async function fetchOk(fetchFunction, url, options = {}) {
  const response = await fetchFunction(url, { cache: 'no-store', ...options });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

async function fetchGitHubApi(fetchFunction, path) {
  const response = await fetchOk(
    fetchFunction,
    `https://api.github.com/repos/${REPOSITORY}/${path}`,
    {
      headers: { accept: 'application/vnd.github+json' },
    },
  );
  return response.json();
}

/**
 * The release to check: the named one, or the newest web-<commit> release. Its commit is the one
 * its tag points at (the release's own target_commitish is metadata that can say anything, or
 * just "main"), and the tag's name must start that commit, so the SHA256SUMS, the commit and the
 * .htaccess read from it belong together.
 */
async function findRelease(fetchFunction, requestedTag) {
  const answer = await fetchGitHubApi(
    fetchFunction,
    requestedTag ? `releases/tags/${encodeURIComponent(requestedTag)}` : 'releases?per_page=30',
  );
  const release = requestedTag
    ? answer
    : answer.find((candidate) => !candidate.draft && RELEASE_TAG_PATTERN.test(candidate.tag_name));
  if (!release || release.draft || !RELEASE_TAG_PATTERN.test(release.tag_name))
    throw new Error('no web-<commit> release found');
  const tag = release.tag_name;
  if (requestedTag && tag !== requestedTag)
    throw new Error(`asked for ${requestedTag}, got ${tag}`);
  const tagReference = await fetchGitHubApi(fetchFunction, `git/ref/tags/${tag}`);
  const commit = tagReference?.object?.sha;
  if (
    tagReference?.ref !== `refs/tags/${tag}` ||
    tagReference.object?.type !== 'commit' ||
    !COMMIT_PATTERN.test(commit ?? '') ||
    !commit.startsWith(tag.slice('web-'.length))
  )
    throw new Error(`the tag ${tag} does not point at a commit starting ${tag.slice(4)}`);
  // A release whose metadata names a different commit than its tag is inconsistent: refuse it.
  const recordedCommit = release.target_commitish;
  if (COMMIT_PATTERN.test(recordedCommit ?? '') && recordedCommit !== commit)
    throw new Error(`${tag} names another commit: ${JSON.stringify(recordedCommit)}`);

  const checksumsAssets = release.assets.filter((asset) => asset.name === 'SHA256SUMS');
  const checksumsUrl = `https://github.com/${REPOSITORY}/releases/download/${tag}/SHA256SUMS`;
  if (checksumsAssets.length !== 1 || checksumsAssets[0].browser_download_url !== checksumsUrl)
    throw new Error(`${tag} has no single SHA256SUMS at ${checksumsUrl}`);
  // At most one SBOM, at its own address (whether it may be missing is checked in checkSbom).
  const sbomAssets = release.assets.filter((asset) => asset.name === SBOM_NAME);
  const sbomUrl = `https://github.com/${REPOSITORY}/releases/download/${tag}/${SBOM_NAME}`;
  if (sbomAssets.length > 1 || sbomAssets.some((asset) => asset.browser_download_url !== sbomUrl))
    throw new Error(`${tag} has more than one ${SBOM_NAME}, or one that is not at ${sbomUrl}`);
  return { tag, commit, checksumsUrl, sbomUrl: sbomAssets.length === 1 ? sbomUrl : null };
}

/**
 * What is deployed comes from main only: the commit must be main or one of its ancestors. main
 * is read as the branch's commit first, so a tag named "main" can never stand in for it.
 */
async function checkCommitIsOnMain(fetchFunction, commit) {
  const mainReference = await fetchGitHubApi(fetchFunction, 'git/ref/heads/main');
  const mainCommit = mainReference?.object?.sha;
  if (
    mainReference?.ref !== 'refs/heads/main' ||
    mainReference.object?.type !== 'commit' ||
    !COMMIT_PATTERN.test(mainCommit ?? '')
  )
    throw new Error('could not read the main branch');
  const comparison = await fetchGitHubApi(
    fetchFunction,
    `compare/${commit}...${mainCommit}?per_page=1`,
  );
  const isOnMain =
    (comparison?.status === 'identical' || comparison?.status === 'ahead') &&
    comparison.merge_base_commit?.sha === commit;
  if (!isOnMain) throw new Error(`commit ${commit} is not on main`);
}

/**
 * The `gh attestation verify` arguments that tie a release file (SHA256SUMS or the SBOM) to
 * deploy-web.yml, main and a commit.
 */
export function attestationArguments(filePath, commit) {
  return [
    'attestation',
    'verify',
    filePath,
    '--repo',
    REPOSITORY,
    '--signer-workflow',
    SIGNER_WORKFLOW,
    '--source-ref',
    'refs/heads/main',
    '--source-digest',
    commit,
    '--deny-self-hosted-runners',
  ];
}

/** Runs gh: { isInstalled: false } when there is none, else its exit code and output. */
function runGitHubCli(ghArguments) {
  const result = spawnSync('gh', ghArguments, { encoding: 'utf8', timeout: 120_000 });
  if (result.error?.code === 'ENOENT') return { isInstalled: false };
  if (result.error) throw result.error;
  return { isInstalled: true, exitCode: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * A release file (SHA256SUMS, or the SBOM) must carry an attestation signed for deploy-web.yml on
 * main at the release's commit: a release made any other way (another workflow, someone with
 * write access), or a genuine file of another commit attached to this release, fails.
 */
function checkProvenance(runGh, fileName, fileBytes, commit) {
  const folder = mkdtempSync(join(tmpdir(), 'verify-deployed-'));
  try {
    const filePath = join(folder, fileName);
    writeFileSync(filePath, fileBytes);
    const result = runGh(attestationArguments(filePath, commit));
    if (!result.isInstalled)
      throw new Error(
        'checking who made the release needs the GitHub CLI (gh), signed in. Install it, or ' +
          'pass --skip-provenance to check only the files and headers.',
      );
    if (result.exitCode !== 0)
      throw new Error(
        `${fileName} is not attested by deploy-web.yml on main for ${commit}: ` +
          result.output.trim().slice(-300),
      );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * The release's SBOM must be a CycloneDX SBOM attested like SHA256SUMS. It says what the app is
 * made of; the site is checked against SHA256SUMS, not against the SBOM. A release may lack one
 * only if deploy-web.yml at its commit does not publish one (a commit from before SBOMs): else
 * it was made some other way, or with its SBOM left out. Returns the line to print.
 */
async function checkSbom({ fetchFunction, runGh, release, isProvenanceChecked }) {
  if (release.sbomUrl === null) {
    const workflowUrl = `https://raw.githubusercontent.com/${REPOSITORY}/${release.commit}/.github/workflows/deploy-web.yml`;
    const workflowText = await (await fetchOk(fetchFunction, workflowUrl)).text();
    if (workflowText.includes(SBOM_NAME))
      throw new Error(
        `${release.tag} has no ${SBOM_NAME}, but deploy-web.yml at its commit publishes one`,
      );
    return '  NOTE     no SBOM in this release (its commit is from before SBOMs were published)';
  }
  const sbomBytes = new Uint8Array(
    await (await fetchOk(fetchFunction, release.sbomUrl)).arrayBuffer(),
  );
  const componentCount = countSbomComponents(new TextDecoder().decode(sbomBytes));
  if (!isProvenanceChecked)
    return `  OK       ${SBOM_NAME}: CycloneDX SBOM of ${componentCount} components`;
  checkProvenance(runGh, SBOM_NAME, sbomBytes, release.commit);
  return `  OK       ${SBOM_NAME}: CycloneDX SBOM of ${componentCount} components, attested the same way`;
}

export async function main(
  commandLineArguments,
  { fetchFunction = fetch, log = console.log, runGh = runGitHubCli } = {},
) {
  const say = (line) => log(printable(line));
  try {
    const options = readOptions(commandLineArguments);
    const siteUrl = options['--site'] ?? DEFAULT_SITE;
    if (new URL(siteUrl).protocol !== 'https:') throw new Error('--site must be an https:// URL');
    const isLocalRebuild = '--sums' in options;
    let release;
    let checksumsBytes;
    if (isLocalRebuild) {
      // Your own rebuild instead of a published release (SECURITY.md).
      release = { tag: `local file ${options['--sums']}`, commit: options['--commit'] };
      checksumsBytes = new Uint8Array(readFileSync(options['--sums']));
    } else {
      release = await findRelease(fetchFunction, options['--release']);
      checksumsBytes = new Uint8Array(
        await (await fetchOk(fetchFunction, release.checksumsUrl)).arrayBuffer(),
      );
    }
    const hashesByPath = parseChecksums(new TextDecoder().decode(checksumsBytes));
    await checkCommitIsOnMain(fetchFunction, release.commit);
    const isProvenanceChecked = !isLocalRebuild && !options['--skip-provenance'];
    if (isProvenanceChecked) checkProvenance(runGh, 'SHA256SUMS', checksumsBytes, release.commit);

    const sbomSummary = isLocalRebuild
      ? null
      : await checkSbom({ fetchFunction, runGh, release, isProvenanceChecked });

    const htaccessUrl = `https://raw.githubusercontent.com/${REPOSITORY}/${release.commit}/apps/web/public/.htaccess`;
    const htaccessBytes = new Uint8Array(
      await (await fetchOk(fetchFunction, htaccessUrl)).arrayBuffer(),
    );
    if (sha256Hex(htaccessBytes) !== hashesByPath.get('.htaccess'))
      throw new Error('the .htaccess in SHA256SUMS is not the one at the release commit');
    const expectedHeaders = readAlwaysSetHeaders(new TextDecoder().decode(htaccessBytes));

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
    say(`Release ${release.tag} (commit ${release.commit}) against ${siteUrl}:`);
    if (isProvenanceChecked) say('  OK       attested by deploy-web.yml on main for this commit');
    if (sbomSummary !== null) say(sbomSummary);
    for (const item of passed) say(`  OK       ${item}`);
    for (const problem of problems) say(`  MISMATCH ${problem}`);
    if (problems.length > 0) {
      say(`${problems.length} problem(s): the live site is NOT this release.`);
      return 1;
    }
    say('The live site serves exactly this release, with its security headers.');
    if (options['--skip-provenance'])
      say('Who made this release was NOT checked (--skip-provenance): see SECURITY.md.');
    return 0;
  } catch (error) {
    say(`Could not verify: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Run as a script (also through a symlinked path: compare real paths, never fail open).
const invokedPath = process.argv[1] === undefined ? '' : realpathSync(process.argv[1]);
if (invokedPath === realpathSync(new URL(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
