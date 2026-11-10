// Build check for dist/.htaccess: every security header is set, unconditionally, and is not
// weaker than expected. Returns a list of problems (empty = fine).
//
// Tightening a header on purpose means editing the expectations below in the same change.

export type HeaderDirective = {
  action: string;
  headerName: string;
  headerValue: string | undefined;
  hasCondition: boolean;
  isAlways: boolean;
  isTopLevel: boolean;
};

/** Splits a line into words; a double-quoted value stays one word (quotes removed). */
function splitIntoWords(line: string): string[] {
  const words: string[] = [];
  for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    words.push(match[1] ?? match[2] ?? '');
  }
  return words;
}

/** Every `Header` line of an .htaccess file (also used by the end-to-end test server). */
export function readHeaderDirectives(htaccessText: string): HeaderDirective[] {
  const joinedText = htaccessText.replace(/\\\r?\n/g, ' ');
  const headerDirectives: HeaderDirective[] = [];
  let sectionDepth = 0;
  for (const rawLine of joinedText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^<\//.test(line)) {
      sectionDepth = Math.max(0, sectionDepth - 1);
      continue;
    }
    if (/^</.test(line)) {
      sectionDepth += 1;
      continue;
    }
    const words = splitIntoWords(line);
    if ((words[0] ?? '').toLowerCase() !== 'header') continue;
    let wordIndex = 1;
    const isAlways = (words[wordIndex] ?? '').toLowerCase() === 'always';
    if (isAlways || (words[wordIndex] ?? '').toLowerCase() === 'onsuccess') wordIndex += 1;
    const action = (words[wordIndex++] ?? '').toLowerCase();
    const headerName = (words[wordIndex++] ?? '').toLowerCase();
    const headerValue = words[wordIndex++];
    headerDirectives.push({
      action,
      headerName,
      headerValue,
      hasCondition: words.length > wordIndex,
      isAlways,
      isTopLevel: sectionDepth === 0,
    });
  }
  return headerDirectives;
}

function cspSources(cspText: string): Map<string, string[]> | string {
  const directiveSources = new Map<string, string[]>();
  for (const directiveText of cspText.split(';')) {
    const words = directiveText.trim().split(/\s+/).filter(Boolean);
    const directiveName = (words[0] ?? '').toLowerCase();
    if (directiveName === '') continue;
    if (directiveSources.has(directiveName)) return `directive "${directiveName}" appears twice`;
    directiveSources.set(
      directiveName,
      words.slice(1).map((source) => source.toLowerCase()),
    );
  }
  return directiveSources;
}

const SIGNALING_ORIGIN = 'wss://signal.securevideocall.com';

/** Per CSP directive: sources that must be present, and the only sources that may be present. */
const EXPECTED_CSP_DIRECTIVES: Record<string, { required: string[]; allowed: string[] }> = {
  'default-src': { required: ["'self'"], allowed: ["'self'"] },
  'script-src': { required: ["'self'"], allowed: ["'self'"] },
  'script-src-attr': { required: ["'none'"], allowed: ["'none'"] },
  'style-src': { required: ["'self'"], allowed: ["'self'"] },
  'img-src': { required: ["'self'"], allowed: ["'self'", 'data:', 'blob:'] },
  'media-src': { required: ["'self'"], allowed: ["'self'", 'blob:'] },
  'font-src': { required: ["'none'"], allowed: ["'none'"] },
  'connect-src': {
    required: ["'self'", SIGNALING_ORIGIN],
    allowed: ["'self'", SIGNALING_ORIGIN],
  },
  'worker-src': { required: ["'none'"], allowed: ["'none'"] },
  'frame-src': { required: ["'none'"], allowed: ["'none'"] },
  'manifest-src': { required: ["'none'"], allowed: ["'none'"] },
  'object-src': { required: ["'none'"], allowed: ["'none'"] },
  'base-uri': { required: ["'none'"], allowed: ["'none'"] },
  'form-action': { required: ["'none'"], allowed: ["'none'"] },
  'frame-ancestors': { required: ["'none'"], allowed: ["'none'"] },
  'require-trusted-types-for': { required: ["'script'"], allowed: ["'script'"] },
  'trusted-types': { required: ["'none'"], allowed: ["'none'"] },
  'upgrade-insecure-requests': { required: [], allowed: [] },
};

function checkContentSecurityPolicy(cspText: string): string[] {
  const directiveSources = cspSources(cspText);
  if (typeof directiveSources === 'string') return [`Content-Security-Policy: ${directiveSources}`];
  const problems: string[] = [];
  for (const [directiveName, sources] of directiveSources) {
    const expectedDirective = EXPECTED_CSP_DIRECTIVES[directiveName];
    if (expectedDirective === undefined) {
      problems.push(`Content-Security-Policy: directive "${directiveName}" is not expected`);
      continue;
    }
    for (const source of sources) {
      if (!expectedDirective.allowed.includes(source)) {
        problems.push(`Content-Security-Policy: "${source}" is not allowed in ${directiveName}`);
      }
    }
  }
  for (const [directiveName, expectedDirective] of Object.entries(EXPECTED_CSP_DIRECTIVES)) {
    const sources = directiveSources.get(directiveName);
    if (sources === undefined) {
      problems.push(`Content-Security-Policy: directive "${directiveName}" is missing`);
      continue;
    }
    for (const requiredSource of expectedDirective.required) {
      if (!sources.includes(requiredSource)) {
        problems.push(`Content-Security-Policy: ${directiveName} lacks ${requiredSource}`);
      }
    }
  }
  return problems;
}

function checkStrictTransportSecurity(headerValue: string): string[] {
  const problems: string[] = [];
  if ((headerValue.match(/max-age=/gi) ?? []).length > 1) {
    problems.push('Strict-Transport-Security: max-age appears more than once');
  }
  const maxAgeSeconds = Number(/max-age=(\d+)/i.exec(headerValue)?.[1] ?? 0);
  if (maxAgeSeconds < 31536000) problems.push('Strict-Transport-Security: max-age is under a year');
  if (!/(^|;)\s*includeSubDomains\s*(;|$)/i.test(headerValue)) {
    problems.push('Strict-Transport-Security: includeSubDomains is missing');
  }
  return problems;
}

const REQUIRED_PERMISSIONS = {
  camera: '(self)',
  microphone: '(self)',
  geolocation: '()',
  payment: '()',
  usb: '()',
};

function checkPermissionsPolicy(headerValue: string): string[] {
  const problems: string[] = [];
  const featureAllowlists = new Map<string, string>();
  for (const entry of headerValue.split(',')) {
    const [featureName, allowlist] = entry.trim().split('=');
    if (!featureName || allowlist === undefined) {
      problems.push(`Permissions-Policy: cannot read entry "${entry.trim()}"`);
      continue;
    }
    featureAllowlists.set(featureName.trim().toLowerCase(), allowlist.trim().toLowerCase());
  }
  for (const [featureName, allowlist] of featureAllowlists) {
    if (allowlist !== '()' && allowlist !== '(self)') {
      problems.push(`Permissions-Policy: ${featureName}=${allowlist} is wider than (self)`);
    }
  }
  for (const [featureName, expectedAllowlist] of Object.entries(REQUIRED_PERMISSIONS)) {
    if (featureAllowlists.get(featureName) !== expectedAllowlist) {
      problems.push(`Permissions-Policy: ${featureName} must be ${expectedAllowlist}`);
    }
  }
  return problems;
}

/** Headers whose whole value must equal one string (compared without case). */
const EXACT_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'deny',
};

const CHECKED_HEADER_NAMES = [
  'strict-transport-security',
  'content-security-policy',
  'permissions-policy',
  ...Object.keys(EXACT_HEADERS),
];

export function checkSecurityHeaders(htaccessText: string): string[] {
  const headerDirectives = readHeaderDirectives(htaccessText);
  const problems: string[] = [];
  for (const headerName of CHECKED_HEADER_NAMES) {
    const directives = headerDirectives.filter((directive) => directive.headerName === headerName);
    const setDirectives = directives.filter((directive) => directive.action === 'set');
    const [onlySetDirective] = setDirectives;
    if (onlySetDirective === undefined) {
      problems.push(`${headerName}: header is missing`);
      continue;
    }
    if (directives.length > 1) {
      problems.push(`${headerName}: must be set exactly once and never changed or unset later`);
    }
    if (!onlySetDirective.isAlways) problems.push(`${headerName}: must use "Header always set"`);
    if (onlySetDirective.hasCondition) problems.push(`${headerName}: must not be conditional`);
    if (!onlySetDirective.isTopLevel) problems.push(`${headerName}: must not be inside a section`);
    const headerValue = onlySetDirective.headerValue ?? '';
    if (headerName === 'content-security-policy') {
      problems.push(...checkContentSecurityPolicy(headerValue));
    } else if (headerName === 'strict-transport-security') {
      problems.push(...checkStrictTransportSecurity(headerValue));
    } else if (headerName === 'permissions-policy') {
      problems.push(...checkPermissionsPolicy(headerValue));
    } else if (headerValue.trim().toLowerCase() !== EXACT_HEADERS[headerName]) {
      problems.push(`${headerName}: must be "${EXACT_HEADERS[headerName]}"`);
    }
  }
  // An unset, edit or echo whose name is a pattern could change one of our headers.
  for (const directive of headerDirectives) {
    const isPattern = /[^a-z0-9-]/.test(directive.headerName);
    if (['unset', 'edit', 'edit*', 'echo'].includes(directive.action) && isPattern) {
      problems.push(`"Header ${directive.action} ${directive.headerName}" could change a header`);
    }
  }
  return problems;
}
