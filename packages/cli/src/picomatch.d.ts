/**
 * Ambient typings for picomatch (CJS, ships no types).
 * The CLI matches repository paths and literal runner testMatch globs.
 */
declare module 'picomatch' {
  interface PicomatchOptions {
    /** Match dotfiles (anything under a leading-dot directory). */
    dot?: boolean;
    /** Match a slash-free runner pattern against the file basename. */
    matchBase?: boolean;
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