// Serves the built app (dist/) for the end-to-end tests with the production headers: every
// top-level `Header always set` of dist/.htaccess, read with the same parser as the build check,
// so the tests run under the real CSP (Trusted Types included) and the two cannot drift.
// Test-only change: connect-src names the local signaling server instead of the production one.
//
// Run with Node's type stripping: node e2e/serveBuiltSite.ts
// Settings: E2E_SITE_PORT (default 4173), E2E_SIGNALING_ORIGIN (default ws://localhost:8000).
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { checkSecurityHeaders, readHeaderDirectives } from '../build-tools/securityHeadersCheck.ts';

const PRODUCTION_SIGNALING_ORIGIN = 'wss://signal.securevideocall.com';
const buildFolderPath = resolve(import.meta.dirname, '..', 'dist');
const sitePort = Number(process.env.E2E_SITE_PORT ?? '4173');
const localSignalingOrigin = process.env.E2E_SIGNALING_ORIGIN ?? 'ws://localhost:8000';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function readProductionHeaders(): Record<string, string> {
  const htaccessText = readFileSync(join(buildFolderPath, '.htaccess'), 'utf8');
  // Only top-level "Header always set" lines are applied below, which matches production as long
  // as the build check passes (it forbids conditional, unset or weaker headers). So run it first.
  const headerProblems = checkSecurityHeaders(htaccessText);
  if (headerProblems.length > 0) {
    throw new Error(`dist/.htaccess fails the build check:\n${headerProblems.join('\n')}`);
  }
  const headers: Record<string, string> = {};
  for (const directive of readHeaderDirectives(htaccessText)) {
    if (directive.isTopLevel && directive.isAlways && directive.action === 'set') {
      if (directive.headerValue !== undefined)
        headers[directive.headerName] = directive.headerValue;
    }
  }
  const contentSecurityPolicy = headers['content-security-policy'];
  if (contentSecurityPolicy === undefined) {
    throw new Error('dist/.htaccess has no Content-Security-Policy header');
  }
  headers['content-security-policy'] = replaceSignalingOriginInConnectSrc(contentSecurityPolicy);
  return headers;
}

/** Swaps the production signaling origin for the local one, only as a whole connect-src source. */
function replaceSignalingOriginInConnectSrc(contentSecurityPolicy: string): string {
  let isSignalingOriginReplaced = false;
  const directives = contentSecurityPolicy.split(';').map((directiveText) => {
    const sources = directiveText.trim().split(/\s+/);
    if (sources[0] !== 'connect-src') return directiveText;
    return sources
      .map((source) => {
        if (source !== PRODUCTION_SIGNALING_ORIGIN) return source;
        isSignalingOriginReplaced = true;
        return localSignalingOrigin;
      })
      .join(' ');
  });
  if (!isSignalingOriginReplaced) {
    throw new Error('dist/.htaccess has no connect-src naming the production signaling origin');
  }
  return directives.join(';');
}

/**
 * The file to send for a URL path: a file inside dist/, else index.html (the app's one page), or
 * null (404) for a dotfile such as .htaccess, whatever its case or encoding.
 */
function resolveFilePath(urlPath: string): string | null {
  let decodedUrlPath: string;
  try {
    decodedUrlPath = decodeURIComponent(urlPath);
  } catch {
    // Malformed percent-encoding: serve the app's page instead of crashing the server.
    return join(buildFolderPath, 'index.html');
  }
  if (decodedUrlPath.split(/[\\/]/).some((segment) => segment.startsWith('.'))) return null;
  const requestedPath = resolve(buildFolderPath, '.' + normalize(decodedUrlPath));
  const isInsideBuild = requestedPath.startsWith(buildFolderPath + sep);
  if (isInsideBuild) {
    try {
      if (statSync(requestedPath).isFile()) return requestedPath;
    } catch {
      // Not a file: fall through to the app's page.
    }
  }
  return join(buildFolderPath, 'index.html');
}

const productionHeaders = readProductionHeaders();
createServer((request, response) => {
  const filePath = resolveFilePath(new URL(request.url ?? '/', 'http://localhost').pathname);
  if (filePath === null) {
    response.writeHead(404, productionHeaders);
    response.end();
    return;
  }
  response.writeHead(200, {
    ...productionHeaders,
    'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
  });
  response.end(readFileSync(filePath));
}).listen(sitePort, '127.0.0.1', () => {
  console.log(
    `end-to-end site on http://localhost:${sitePort}/ (CSP connect-src: ${localSignalingOrigin})`,
  );
});
