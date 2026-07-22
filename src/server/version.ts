/**
 * Application version, resolved at runtime.
 *
 * WHY a function and not a top-level constant reading a JSON import: `src` is the
 * TypeScript `rootDir`, so importing the repo-root `package.json` would push an emit
 * outside `dist/src` and break the build layout. Reading `npm_package_version` (set
 * by the package manager when the process is launched via a script) inside a function
 * keeps the lookup off the import path, with a stable fallback for tests and for a
 * process started directly with `node`.
 */

/** The running application version, e.g. "0.1.0". */
export function appVersion(): string {
  const fromEnv = process.env['npm_package_version'];
  return fromEnv && fromEnv.length > 0 ? fromEnv : '0.1.0';
}
