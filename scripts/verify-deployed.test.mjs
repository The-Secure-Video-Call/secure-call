// Tests for verify-deployed.mjs, with a fake fetch. Run with: node --test 'scripts/*.test.mjs'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, parseChecksums, readAlwaysSetHeaders, sha256Hex } from './verify-deployed.mjs';

const COMMIT = 'a'.repeat(40);
const TAG = 'web-aaaaaaaaaaaa';
// The script's default site; the fake answers for this exact origin only.
const SITE_ORIGIN = 'https://securevideocall.com';
const CSP = "default-src 'self'; script-src 'self'";
const HTACCESS = [
  '# comment',
  `Header always set Content-Security-Policy "${CSP}"`,
  'Header always set X-Content-Type-Options "nosniff"',
  '<FilesMatch "^index\\.html$">',
  '  Header set Cache-Control "no-cache"',
  '</FilesMatch>',
].join('\n');
const SCRIPT = 'console.log("app")';
const STYLES = 'body{}';
const INDEX_HTML =
  '<html><head><script type="module" src="/assets/index-AAA.js"></script>' +
  '<link rel="stylesheet" href="/assets/index-BBB.css"></head></html>';

function checksumsFor(files) {
  return Object.entries(files)
    .map(([path, content]) => `${sha256Hex(Buffer.from(content))}  ./${path}`)
    .join('\n');
}

/** A fake fetch serving a release, the repository's .htaccess and a site, with overrides. */
function fakeWorld({ site = {}, siteHeaders = {}, checksums, redirectSite = false } = {}) {
  const siteFiles = {
    '/': INDEX_HTML,
    '/assets/index-AAA.js': SCRIPT,
    '/assets/index-BBB.css': STYLES,
    ...site,
  };
  const releasedFiles = {
    'index.html': INDEX_HTML,
    '.htaccess': HTACCESS,
    'assets/index-AAA.js': SCRIPT,
    'assets/index-BBB.css': STYLES,
  };
  const responses = new Map([
    [
      'https://api.github.com/repos/The-Secure-Video-Call/secure-call/releases?per_page=30',
      JSON.stringify([
        { tag_name: 'v1.0.0', draft: false, target_commitish: COMMIT, assets: [] },
        {
          tag_name: TAG,
          draft: false,
          target_commitish: COMMIT,
          assets: [
            { name: 'SHA256SUMS', browser_download_url: 'https://downloads.example/SHA256SUMS' },
          ],
        },
      ]),
    ],
    ['https://downloads.example/SHA256SUMS', checksums ?? checksumsFor(releasedFiles)],
    [
      `https://raw.githubusercontent.com/The-Secure-Video-Call/secure-call/${COMMIT}/apps/web/public/.htaccess`,
      HTACCESS,
    ],
  ]);
  const defaultHeaders = {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    ...siteHeaders,
  };
  const requested = [];
  const fetchFunction = async (url, options = {}) => {
    requested.push(url);
    if (new URL(url).origin === SITE_ORIGIN) {
      if (redirectSite && options.redirect === 'error')
        throw new TypeError('fetch failed: redirect');
      const body = siteFiles[new URL(url).pathname];
      if (body === undefined) return new Response('not found', { status: 404 });
      const headers = Object.fromEntries(
        Object.entries(defaultHeaders).filter(([, value]) => value !== undefined),
      );
      return new Response(body, { status: 200, headers });
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
  return { exitCode, output: lines.join('\n') };
}

test('a site serving exactly the release, with its headers, passes', async () => {
  const { exitCode, output } = await run(fakeWorld());
  assert.equal(exitCode, 0, output);
  assert.match(output, /Release web-aaaaaaaaaaaa \(commit a{40}\)/);
  assert.match(output, /OK {7}assets\/index-AAA\.js/);
  assert.match(output, /OK {7}header content-security-policy/);
});

test('negative: one changed byte in index.html fails', async () => {
  const { exitCode, output } = await run(
    fakeWorld({ site: { '/': INDEX_HTML.replace('</html>', '</html> ') } }),
  );
  assert.equal(exitCode, 1);
  assert.match(output, /MISMATCH index\.html differs from the release/);
});

test('negative: a changed asset fails', async () => {
  const { exitCode, output } = await run(
    fakeWorld({ site: { '/assets/index-AAA.js': SCRIPT + ';' } }),
  );
  assert.equal(exitCode, 1);
  assert.match(output, /MISMATCH assets\/index-AAA\.js differs from the release/);
});

test('negative: a missing asset fails (the server answers 404)', async () => {
  const { exitCode, output } = await run(
    fakeWorld({ site: { '/assets/index-BBB.css': undefined } }),
  );
  assert.equal(exitCode, 1);
  assert.match(output, /Could not verify: .*index-BBB\.css answered 404/);
});

test('negative: an extra script in index.html that is not in the release fails', async () => {
  const injected = INDEX_HTML.replace(
    '</head>',
    '<script src="/assets/extra-CCC.js"></script></head>',
  );
  const releasedFiles = {
    'index.html': injected,
    'assets/index-AAA.js': SCRIPT,
    'assets/index-BBB.css': STYLES,
  };
  const { exitCode, output } = await run(
    fakeWorld({ site: { '/': injected }, checksums: checksumsFor(releasedFiles) }),
  );
  assert.equal(exitCode, 1);
  assert.match(output, /index\.html loads assets\/extra-CCC\.js, which is not in the release/);
});

test('negative: an off-site script in index.html fails', async () => {
  const injected = INDEX_HTML.replace(
    '</head>',
    '<script src="https://cdn.example/x.js"></script></head>',
  );
  const releasedFiles = {
    'index.html': injected,
    'assets/index-AAA.js': SCRIPT,
    'assets/index-BBB.css': STYLES,
  };
  const { exitCode, output } = await run(
    fakeWorld({ site: { '/': injected }, checksums: checksumsFor(releasedFiles) }),
  );
  assert.equal(exitCode, 1);
  assert.match(output, /index\.html loads something off-site: https:\/\/cdn\.example\/x\.js/);
});

test('negative: a weakened or missing CSP fails even when every file matches', async () => {
  for (const liveCsp of ["default-src 'self'; script-src 'self' 'unsafe-inline'", undefined]) {
    const { exitCode, output } = await run(
      fakeWorld({ siteHeaders: { 'content-security-policy': liveCsp } }),
    );
    assert.equal(exitCode, 1, String(liveCsp));
    assert.match(output, /MISMATCH header content-security-policy/);
  }
});

test('negative: a site that redirects elsewhere fails', async () => {
  const { exitCode, output } = await run(fakeWorld({ redirectSite: true }));
  assert.equal(exitCode, 1);
  assert.match(output, /Could not verify: fetch failed: redirect/);
});

test('negative: malformed SHA256SUMS and an unknown release fail', async () => {
  for (const checksums of ['not a checksum line', `${'0'.repeat(64)}  ../../etc/passwd`]) {
    const { exitCode, output } = await run(fakeWorld({ checksums }));
    assert.equal(exitCode, 1);
    assert.match(output, /Could not verify: bad SHA256SUMS line/);
  }
  const { exitCode, output } = await run(fakeWorld(), ['--release', 'web-bbbbbbbbbbbb']);
  assert.equal(exitCode, 1);
  assert.match(output, /Could not verify: .*answered 404/);
});

test('parsing helpers: checksums need index.html; only top-level always-set headers count', () => {
  assert.throws(() => parseChecksums(`${'0'.repeat(64)}  ./assets/a.js`), /no index\.html/);
  assert.deepEqual(
    [...readAlwaysSetHeaders(HTACCESS)],
    [
      ['content-security-policy', CSP],
      ['x-content-type-options', 'nosniff'],
    ],
  );
});
