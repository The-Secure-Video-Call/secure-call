import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkSecurityHeaders } from './securityHeadersCheck.ts';

const realHtaccessText = readFileSync(new URL('../public/.htaccess', import.meta.url), 'utf8');

/** The real file with one line replaced (or removed when the new text is empty). */
function htaccessWithLineChanged(linePrefix: string, newLine: string): string {
  const lines = realHtaccessText.split('\n');
  const lineIndex = lines.findIndex((line) => line.startsWith(linePrefix));
  expect(lineIndex).toBeGreaterThan(-1);
  lines[lineIndex] = newLine;
  return lines.join('\n');
}

const cspLinePrefix = 'Header always set Content-Security-Policy';
const realCspValue = /Content-Security-Policy "([^"]+)"/.exec(realHtaccessText)?.[1] ?? '';

function htaccessWithCsp(cspValue: string): string {
  return htaccessWithLineChanged(
    cspLinePrefix,
    `Header always set Content-Security-Policy "${cspValue}"`,
  );
}

describe('checkSecurityHeaders', () => {
  it('accepts the real public/.htaccess', () => {
    expect(checkSecurityHeaders(realHtaccessText)).toEqual([]);
  });

  it('rejects each missing header', () => {
    const headerNames = [
      'Strict-Transport-Security',
      'Content-Security-Policy',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Cross-Origin-Opener-Policy',
      'Cross-Origin-Resource-Policy',
      'X-Frame-Options',
    ];
    for (const headerName of headerNames) {
      const problems = checkSecurityHeaders(
        htaccessWithLineChanged(`Header always set ${headerName}`, ''),
      );
      expect(problems.join(), headerName).toContain(
        `${headerName.toLowerCase()}: header is missing`,
      );
    }
  });

  it('rejects unsafe-inline, unsafe-eval and wasm-unsafe-eval', () => {
    for (const keyword of ["'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'"]) {
      const problems = checkSecurityHeaders(
        htaccessWithCsp(realCspValue.replace("script-src 'self'", `script-src 'self' ${keyword}`)),
      );
      expect(problems.join(), keyword).toContain(`"${keyword}" is not allowed in script-src`);
    }
  });

  it('rejects a new host in connect-src and a report-uri', () => {
    expect(
      checkSecurityHeaders(
        htaccessWithCsp(
          realCspValue.replace("connect-src 'self'", "connect-src 'self' https://x.example"),
        ),
      ).join(),
    ).toContain('https://x.example');
    expect(
      checkSecurityHeaders(htaccessWithCsp(`${realCspValue}; report-uri https://x.example`)).join(),
    ).toContain('report-uri');
  });

  it('rejects a CSP that drops a directive or loosens one', () => {
    expect(
      checkSecurityHeaders(
        htaccessWithCsp(realCspValue.replace("trusted-types 'none'; ", '')),
      ).join(),
    ).toContain('"trusted-types" is missing');
    expect(
      checkSecurityHeaders(
        htaccessWithCsp(realCspValue.replace("worker-src 'none'", "worker-src 'self'")),
      ).join(),
    ).toContain('worker-src');
    expect(
      checkSecurityHeaders(htaccessWithCsp(`${realCspValue}; script-src 'self'`)).join(),
    ).toContain('appears twice');
  });

  it('rejects weaker values of the simple headers', () => {
    expect(
      checkSecurityHeaders(
        htaccessWithLineChanged(
          'Header always set X-Frame-Options',
          'Header always set X-Frame-Options "SAMEORIGIN"',
        ),
      ).join(),
    ).toContain('x-frame-options');
    expect(
      checkSecurityHeaders(
        htaccessWithLineChanged(
          'Header always set Strict-Transport-Security',
          'Header always set Strict-Transport-Security "max-age=60"',
        ),
      ).join(),
    ).toContain('max-age');
    expect(
      checkSecurityHeaders(
        htaccessWithLineChanged(
          'Header always set Permissions-Policy',
          'Header always set Permissions-Policy "camera=*, microphone=(self), geolocation=(), payment=(), usb=()"',
        ),
      ).join(),
    ).toContain('camera');
  });

  it('rejects a repeated HSTS max-age', () => {
    const problems = checkSecurityHeaders(
      htaccessWithLineChanged(
        'Header always set Strict-Transport-Security',
        'Header always set Strict-Transport-Security "max-age=31536000; max-age=0; includeSubDomains"',
      ),
    );
    expect(problems.join()).toContain('more than once');
  });

  it('rejects a header split over lines with a backslash continuation', () => {
    const cspLine = realHtaccessText
      .split('\n')
      .find((line) => line.startsWith('Header always set Content-Security-Policy'));
    expect(cspLine).toBeDefined();
    const splitCsp = (cspLine ?? '').replace("script-src 'self';", "script-src 'self'; \\\n  ");
    const problems = checkSecurityHeaders(realHtaccessText.replace(cspLine ?? '', splitCsp));
    expect(problems.join()).toContain('no line continuations');
  });

  it('rejects a conditional, non-always, nested or later-unset header', () => {
    const referrerLine = 'Header always set Referrer-Policy "no-referrer"';
    expect(
      checkSecurityHeaders(
        htaccessWithLineChanged('Header always set Referrer-Policy', `${referrerLine} env=FOO`),
      ).join(),
    ).toContain('must not be conditional');
    expect(
      checkSecurityHeaders(
        htaccessWithLineChanged(
          'Header always set Referrer-Policy',
          'Header set Referrer-Policy "no-referrer"',
        ),
      ).join(),
    ).toContain('Header always set');
    expect(
      checkSecurityHeaders(`${realHtaccessText}\nHeader always unset Referrer-Policy\n`).join(),
    ).toContain('exactly once');
    expect(
      checkSecurityHeaders(
        htaccessWithLineChanged(
          'Header always set Referrer-Policy',
          `<If "true">\n${referrerLine}\n</If>`,
        ),
      ).join(),
    ).toContain('inside a section');
    expect(
      checkSecurityHeaders(`${realHtaccessText}\nHeader always unset ^X-.*\n`).join(),
    ).toContain('could change a header');
  });
});
