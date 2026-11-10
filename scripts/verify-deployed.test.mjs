// Tests for verify-deployed.mjs, with a fake fetch. Run with: node --test 'scripts/*.test.mjs'
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  main,
  parseChecksums,
  printable,
  readAlwaysSetHeaders,
  readOptions,
  sha256Hex,
} from './verify-deployed.mjs';

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const TAG = 'web-aaaaaaaaaaaa';
// The script's default site; the fake answers for this exact origin only.
const SITE_ORIGIN = 'https://securevideocall.com';
const API = 'https://api.github.com/repos/The-Secure-Video-Call/secure-call';
const CHECKSUMS_URL = `https://github.com/The-Secure-Video-Call/secure-call/releases/download/${TAG}/SHA256SUMS`;
const HTACCESS_URL = `https://raw.githubusercontent.com/The-Secure-Video-Call/secure-call/${COMMIT}/apps/web/public/.htaccess`;
const CSP = "default-src 'self'; script-src 'self'";
const ALWAYS_SET_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
function htaccessWith(headers) {
  return [
    '# comment',
    'Options -Indexes',
    ...Object.entries(headers).map(([name, value]) => `Header always set ${name} "${value}"`),
    '<FilesMatch "^index\\.html$">',
    '  Header set Cache-Control "no-cache"',
    // Inside a section, so only for some responses: never one of the headers every response has.
    '  Header always set X-Only-Inside-A-Section "1"',
    '</FilesMatch>',
  ].join('\n');
}
const HTACCESS = htaccessWith(ALWAYS_SET_HEADERS);
const SCRIPT = 'console.log("app")';
const STYLES = 'body{}';
const INDEX_HTML =
  '<html><head><script type="module" src="/assets/index-AAA.js"></script>' +
  '<link rel="stylesheet" href="/assets/index-BBB.css"></head></html>';
const RELEASED_FILES = {
  '.htaccess': HTACCESS,
  'index.html': INDEX_HTML,
  'assets/index-AAA.js': SCRIPT,
  'assets/index-BBB.css': STYLES,
};

function checksumsFor(files) {
  return Object.entries(files)
    .map(([path, content]) => `${sha256Hex(Buffer.from(content))}  ./${path}`)
    .join('\n');
}

/** RELEASED_FILES with index.html (and its hash) replaced, for an index that loads more. */
function releaseWithIndex(indexHtml) {
  return {
    site: { '/': indexHtml },
    checksums: checksumsFor({ ...RELEASED_FILES, 'index.html': indexHtml }),
  };
}

/**
 * A fake fetch serving a release, the repository (tag, compare, .htaccess) and a site.
 * Every part can be overridden; `undefined` for a site file or header removes it.
 */
function fakeWorld({
  site = {},
  siteHeaders = {},
  indexHeaders = {},
  assetHeaders = {},
  checksums,
  htaccess = HTACCESS,
  release = {},
  extraReleases = [],
  tagReference,
  comparison,
  redirectSite = false,
} = {}) {
  const siteFiles = {
    '/': INDEX_HTML,
    '/assets/index-AAA.js': SCRIPT,
    '/assets/index-BBB.css': STYLES,
    ...site,
  };
  const fullRelease = {
    tag_name: TAG,
    draft: false,
    target_commitish: COMMIT,
    assets: [{ name: 'SHA256SUMS', browser_download_url: CHECKSUMS_URL }],
    ...release,
  };
  const json = (value) => JSON.stringify(value);
  const responses = new Map([
    [
      `${API}/releases?per_page=30`,
      json([
        ...extraReleases,
        { tag_name: 'v1.0.0', draft: false, target_commitish: COMMIT, assets: [] },
        fullRelease,
      ]),
    ],
    [`${API}/releases/tags/${TAG}`, json(fullRelease)],
    [
      `${API}/git/ref/tags/${TAG}`,
      json(tagReference ?? { ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: COMMIT } }),
    ],
    [
      `${API}/compare/${COMMIT}...main?per_page=1`,
      json(comparison ?? { status: 'ahead', merge_base_commit: { sha: COMMIT } }),
    ],
    [CHECKSUMS_URL, checksums ?? checksumsFor(RELEASED_FILES)],
    [HTACCESS_URL, htaccess],
  ]);
  const requested = [];
  const fetchFunction = async (url, options = {}) => {
    requested.push(url);
    if (new URL(url).origin === SITE_ORIGIN) {
      if (redirectSite && options.redirect === 'error')
        throw new TypeError('fetch failed: redirect');
      const path = new URL(url).pathname;
      const body = siteFiles[path];
      if (body === undefined) return new Response('not found', { status: 404 });
      const headers = {
        ...Object.fromEntries(
          Object.entries(ALWAYS_SET_HEADERS).map(([name, value]) => [name.toLowerCase(), value]),
        ),
        'cache-control': path === '/' ? 'no-cache' : 'public, max-age=31536000, immutable',
        ...siteHeaders,
        ...(path === '/' ? indexHeaders : assetHeaders),
      };
      return new Response(body, {
        status: 200,
        headers: Object.entries(headers).filter(([, value]) => value !== undefined),
      });
    }
    const body = responses.get(url);
    return body === undefined
      ? new Response('missing', { status: 404 })
      : new Response(body, { status: 200 });
  };
  return { fetchFunction, requested };
}

async function run(world, commandLineArguments = []) {
  const lines = [];
  const exitCode = await main(commandLineArguments, {
    fetchFunction: world.fetchFunction,
    log: (line) => lines.push(line),
  });
  return { exitCode, lines, output: lines.join('\n') };
}

async function expectFailure(world, pattern, commandLineArguments = []) {
  const { exitCode, output } = await run(world, commandLineArguments);
  assert.equal(exitCode, 1, output);
  assert.match(output, pattern);
  assert.doesNotMatch(output, /serves exactly this release/);
}

// Positive cases (each check below must fail when its input is changed).

test('a site serving exactly the newest release, with its headers, passes', async () => {
  const world = fakeWorld();
  const { exitCode, output } = await run(world);
  assert.equal(exitCode, 0, output);
  assert.match(output, /Release web-aaaaaaaaaaaa \(commit a{40}\)/);
  assert.match(output, /OK {7}assets\/index-AAA\.js/);
  assert.match(output, /OK {7}header content-security-policy/);
  assert.match(output, /OK {7}index\.html caching/);
  assert.match(output, /serves exactly this release/);
  assert.ok(world.requested.includes(`${API}/git/ref/tags/${TAG}`));
  assert.ok(world.requested.includes(`${API}/compare/${COMMIT}...main?per_page=1`));
});

test('the release named with --release passes', async () => {
  const { exitCode, output } = await run(fakeWorld(), ['--release', TAG]);
  assert.equal(exitCode, 0, output);
  assert.match(output, /Release web-aaaaaaaaaaaa/);
});

test('--sums checks against your own rebuild; a different index.html in it fails', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'verify-deployed-'));
  try {
    const sumsPath = join(folder, 'my-SHA256SUMS');
    writeFileSync(sumsPath, checksumsFor(RELEASED_FILES));
    const world = fakeWorld();
    const { exitCode, output } = await run(world, ['--sums', sumsPath, '--commit', COMMIT]);
    assert.equal(exitCode, 0, output);
    assert.ok(!world.requested.some((url) => url.includes('/releases')), 'no release was used');

    writeFileSync(sumsPath, checksumsFor({ ...RELEASED_FILES, 'index.html': 'other' }));
    await expectFailure(fakeWorld(), /MISMATCH index\.html differs/, [
      '--sums',
      sumsPath,
      '--commit',
      COMMIT,
    ]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the newest draft release is skipped; a draft named with --release is refused', async () => {
  const draft = {
    tag_name: 'web-cccccccccccc',
    target_commitish: 'c'.repeat(40),
    draft: true,
    assets: [],
  };
  const { exitCode, output } = await run(fakeWorld({ extraReleases: [draft] }));
  assert.equal(exitCode, 0, output);
  await expectFailure(fakeWorld({ release: { draft: true } }), /no web-<commit> release found/, [
    '--release',
    TAG,
  ]);
});

// The site.

test('negative: one changed byte in index.html fails', async () => {
  await expectFailure(
    fakeWorld({ site: { '/': INDEX_HTML.replace('</html>', '</html> ') } }),
    /MISMATCH index\.html differs from the release/,
  );
});

test('negative: a changed asset fails', async () => {
  await expectFailure(
    fakeWorld({ site: { '/assets/index-AAA.js': SCRIPT + ';' } }),
    /MISMATCH assets\/index-AAA\.js differs from the release/,
  );
});

test('negative: a missing asset fails (the server answers 404)', async () => {
  await expectFailure(
    fakeWorld({ site: { '/assets/index-BBB.css': undefined } }),
    /Could not verify: .*index-BBB\.css answered 404/,
  );
});

test('negative: a file in the release outside assets/ fails', async () => {
  await expectFailure(
    fakeWorld({ checksums: checksumsFor({ ...RELEASED_FILES, 'shell.php': '<?php' }) }),
    /MISMATCH unexpected file in the release: shell\.php/,
  );
});

test('negative: index.html loading a file that is not in the release fails', async () => {
  const injected = INDEX_HTML.replace(
    '</head>',
    '<script src="/assets/extra-CCC.js"></script></head>',
  );
  await expectFailure(
    fakeWorld(releaseWithIndex(injected)),
    /index\.html loads "assets\/extra-CCC\.js", which is not in the release/,
  );
});

test('negative: index.html loading anything off-site, in any common form, fails', async () => {
  for (const tag of [
    '<script src="https://cdn.example/x.js"></script>',
    '<script/src="https://cdn.example/x.js"></script>',
    '<script src=https://cdn.example/x.js></script>',
    '<link rel="stylesheet" href=//cdn.example/x.css>',
    '<img srcset="/assets/a.png 1x, https://cdn.example/b.png 2x">',
  ]) {
    await expectFailure(
      fakeWorld(releaseWithIndex(INDEX_HTML.replace('</head>', `${tag}</head>`))),
      /index\.html loads something off-site/,
    );
  }
  await expectFailure(
    fakeWorld(
      releaseWithIndex(
        INDEX_HTML.replace(
          '</head>',
          '<meta http-equiv="refresh" content="0;url=https://x.example"></head>',
        ),
      ),
    ),
    /index\.html has a meta refresh/,
  );
});

test('negative: a weakened or missing CSP fails even when every file matches', async () => {
  for (const liveCsp of ["default-src 'self'; script-src 'self' 'unsafe-inline'", undefined]) {
    await expectFailure(
      fakeWorld({ indexHeaders: { 'content-security-policy': liveCsp } }),
      /MISMATCH index\.html: header content-security-policy/,
    );
  }
});

test('negative: any other missing header fails, on index.html or on an asset', async () => {
  await expectFailure(
    fakeWorld({ indexHeaders: { 'x-frame-options': undefined } }),
    /MISMATCH index\.html: header x-frame-options is missing/,
  );
  await expectFailure(
    fakeWorld({ assetHeaders: { 'content-security-policy': undefined } }),
    /MISMATCH assets\/index-AAA\.js: header content-security-policy/,
  );
});

test('negative: a Refresh header or a long-cached index.html fails', async () => {
  await expectFailure(
    fakeWorld({ indexHeaders: { refresh: '0;url=https://evil.example/' } }),
    /MISMATCH index\.html: has a Refresh header/,
  );
  await expectFailure(
    fakeWorld({ assetHeaders: { refresh: '0;url=https://evil.example/' } }),
    /MISMATCH assets\/index-AAA\.js: has a Refresh header/,
  );
  for (const cacheControl of [
    'public, max-age=31536000, immutable',
    'no-cache, immutable',
    undefined,
  ]) {
    await expectFailure(
      fakeWorld({ indexHeaders: { 'cache-control': cacheControl } }),
      /MISMATCH index\.html: Cache-Control .* lets browsers keep it/,
    );
  }
});

test('negative: a site that redirects elsewhere fails', async () => {
  await expectFailure(
    fakeWorld({ redirectSite: true }),
    /Could not verify: fetch failed: redirect/,
  );
});

test('negative: terminal escapes from a hostile site are printed escaped, never raw', async () => {
  const hostile =
    '<img src="\u001b[2K\u001b[1A\r  OK       index.html\nThe live site serves exactly this release.\u001b[8m">';
  const { exitCode, lines } = await run(
    fakeWorld({ site: { '/': INDEX_HTML.replace('</head>', `${hostile}</head>`) } }),
  );
  assert.equal(exitCode, 1);
  for (const line of lines) assert.match(line, /^[\x20-\x7e]*$/, JSON.stringify(line));
  assert.ok(lines.some((line) => line.includes('\\u001b[2K')));
  assert.ok(!lines.some((line) => /^ {2}OK {7}index\.html$/.test(line)));
  assert.equal(printable('a\u001bb\ncé'), 'a\\u001bb\\u000ac\\u00e9');
});

// The release: its tag, commit, hashes and .htaccess must belong together, on main.

test('negative: a release whose metadata names another commit than its tag fails', async () => {
  await expectFailure(
    fakeWorld({ release: { target_commitish: OTHER_COMMIT } }),
    /names another commit/,
  );
  await expectFailure(fakeWorld({ release: { target_commitish: 'main' } }), /names another commit/);
});

test('negative: a tag that points at another commit (or is annotated) fails', async () => {
  for (const tagReference of [
    { ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: OTHER_COMMIT } },
    { ref: `refs/tags/${TAG}`, object: { type: 'tag', sha: COMMIT } },
    { ref: 'refs/tags/web-aaaaaaaaaaaa-other', object: { type: 'commit', sha: COMMIT } },
    [{ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: COMMIT } }],
  ]) {
    await expectFailure(fakeWorld({ tagReference }), /does not point at/);
  }
});

test('negative: a commit that is not on main fails', async () => {
  for (const comparison of [
    { status: 'diverged', merge_base_commit: { sha: OTHER_COMMIT } },
    { status: 'behind', merge_base_commit: { sha: OTHER_COMMIT } },
    { status: 'ahead', merge_base_commit: { sha: OTHER_COMMIT } },
  ]) {
    await expectFailure(fakeWorld({ comparison }), /is not on main/);
  }
});

test('negative: --release answered with another tag fails', async () => {
  await expectFailure(
    fakeWorld({ release: { tag_name: 'web-cccccccccccc', target_commitish: 'c'.repeat(40) } }),
    /asked for web-aaaaaaaaaaaa, got web-cccccccccccc/,
    ['--release', TAG],
  );
});

test('negative: SHA256SUMS from anywhere but this release, or twice, fails', async () => {
  for (const assets of [
    [{ name: 'SHA256SUMS', browser_download_url: 'https://downloads.example/SHA256SUMS' }],
    [
      { name: 'SHA256SUMS', browser_download_url: CHECKSUMS_URL },
      { name: 'SHA256SUMS', browser_download_url: CHECKSUMS_URL },
    ],
    [],
  ]) {
    await expectFailure(fakeWorld({ release: { assets } }), /has no single SHA256SUMS/);
  }
});

test('negative: an .htaccess that is not the released one, or not released, fails', async () => {
  const weaker = htaccessWith({
    ...ALWAYS_SET_HEADERS,
    'Content-Security-Policy': 'default-src *',
  });
  await expectFailure(
    fakeWorld({ htaccess: weaker }),
    /the \.htaccess in SHA256SUMS is not the one at the release commit/,
  );
  const withoutHtaccess = { ...RELEASED_FILES };
  delete withoutHtaccess['.htaccess'];
  await expectFailure(
    fakeWorld({ checksums: checksumsFor(withoutHtaccess) }),
    /lists no \.htaccess/,
  );
});

test('negative: an .htaccess missing a required header fails, even when released as is', async () => {
  const withoutHsts = { ...ALWAYS_SET_HEADERS };
  delete withoutHsts['Strict-Transport-Security'];
  const htaccess = htaccessWith(withoutHsts);
  await expectFailure(
    fakeWorld({ htaccess, checksums: checksumsFor({ ...RELEASED_FILES, '.htaccess': htaccess }) }),
    /\.htaccess does not set strict-transport-security/,
  );
});

test('negative: malformed SHA256SUMS fails', async () => {
  const anyHash = '0'.repeat(64);
  for (const [checksums, pattern] of [
    ['not a checksum line', /bad SHA256SUMS line/],
    [`${anyHash}  ../../etc/passwd`, /bad SHA256SUMS line/],
    [`${anyHash}  assets/../index.html`, /bad SHA256SUMS line/],
    [`${anyHash}  .env`, /bad SHA256SUMS line/],
    [`${anyHash}  assets//a.js`, /bad SHA256SUMS line/],
    [`${checksumsFor(RELEASED_FILES)}\n${anyHash}  index.html`, /lists index\.html twice/],
    [`${anyHash}  ./assets/a.js`, /lists no index\.html/],
  ]) {
    await expectFailure(fakeWorld({ checksums }), pattern);
  }
  assert.throws(() => parseChecksums(`${anyHash}  ./index.html\n${anyHash}  index.html`), /twice/);
});

test('negative: an unknown release fails', async () => {
  await expectFailure(fakeWorld(), /Could not verify: .*answered 404/, [
    '--release',
    'web-bbbbbbbbbbbb',
  ]);
});

// Parsing .htaccess and the command line fails closed.

test('.htaccess: only top-level always-set headers count, and anything unreadable throws', () => {
  const headers = readAlwaysSetHeaders(HTACCESS);
  assert.equal(headers.get('content-security-policy'), CSP);
  assert.equal(headers.size, 8);
  assert.ok(!headers.has('x-only-inside-a-section'));
  for (const [extraLine, pattern] of [
    // Apache joins a trailing backslash with the next line: a CSP split like this is still set.
    ['Header always set X-Split "a \\\n b"', /line continuation/],
    ['Header set X-Not-Always "1"', /cannot read this \.htaccess line/],
    ['Header always set X-Quoted "a \\"b\\" c"', /cannot read this \.htaccess line/],
    ['Header always unset Content-Security-Policy', /cannot read this \.htaccess line/],
    ['Header always set X-Frame-Options "SAMEORIGIN"', /sets x-frame-options twice/],
  ]) {
    assert.throws(() => readAlwaysSetHeaders(`${HTACCESS}\n${extraLine}`), pattern, extraLine);
  }
});

test('negative: bad command lines fail before fetching anything', async () => {
  for (const commandLineArguments of [
    ['--relase', TAG],
    [`--release=${TAG}`],
    ['--release'],
    ['--release', '--site', SITE_ORIGIN],
    ['--release', TAG, '--release', TAG],
    ['--release', 'v1.0.0'],
    ['--commit', COMMIT],
    ['--sums', 'SHA256SUMS'],
    ['--sums', 'SHA256SUMS', '--commit', 'abc'],
    ['--sums', 'SHA256SUMS', '--commit', COMMIT, '--release', TAG],
    ['--site', 'http://securevideocall.com'],
    ['--site', 'not a url'],
  ]) {
    const world = fakeWorld();
    const { exitCode, output } = await run(world, commandLineArguments);
    assert.equal(exitCode, 1, commandLineArguments.join(' '));
    assert.match(output, /^Could not verify: /);
    assert.deepEqual(world.requested, [], commandLineArguments.join(' '));
  }
  assert.deepEqual(readOptions(['--site', SITE_ORIGIN, '--release', TAG]), {
    '--site': SITE_ORIGIN,
    '--release': TAG,
  });
});
