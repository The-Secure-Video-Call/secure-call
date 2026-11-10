// Minimal types for the few Node built-ins the build tools use. The project adds no
// @types/node dependency (CLAUDE.md: keep dependencies out of this change), and the web app
// itself must never use these modules. Only build-tools/ may import them.

declare module 'node:fs' {
  export function existsSync(path: string | URL): boolean;
  export function statSync(path: string): { isFile(): boolean };
  export function readFileSync(path: string | URL): Uint8Array;
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function writeFileSync(path: string, content: string | Uint8Array): void;
  export function copyFileSync(source: string | URL, destination: string): void;
  export function mkdirSync(path: string): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export const sep: string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}

declare const process: {
  argv: string[];
  exit(exitCode: number): never;
};
