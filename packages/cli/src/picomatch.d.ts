/**
 * Ambient typings for picomatch (CJS, ships no types).
 * The CLI uses picomatch only to test repo-relative paths against the
 * include/exclude globs from `.gateforge.yml` — a tiny surface.
 */
declare module 'picomatch' {
  interface PicomatchOptions {
    /** Match dotfiles (anything under a leading-dot directory). */
    dot?: boolean;
  }

  /** A compiled glob matcher: true when `path` matches the pattern. */
  interface Matcher {
    (path: string): boolean;
  }

  /** Compiles one glob pattern into a matcher. */
  function picomatch(pattern: string, options?: PicomatchOptions): Matcher;

  export { Matcher };
  export default picomatch;
}