/**
 * Runner logical keys: `<repo-relative-file>#<encoded-title-path>`.
 *
 * Title segments join on `>`; literal `>` and `\` inside a segment are
 * escaped so keys round-trip (vitest titles may contain `>` e.g. angle
 * brackets in schema test names).
 */

/** Escapes one title segment for inclusion in a logical key. */
export function encodeTitlePathSegment(segment: string): string {
  return segment.replace(/\\/g, '\\\\').replace(/>/g, '\\>');
}

/** Joins title path segments into the suffix after `#` in a logical key. */
export function encodeTitlePath(titlePath: readonly string[]): string {
  return titlePath.map(encodeTitlePathSegment).join('>');
}

/** Splits an encoded title-path suffix into segments (after the first `#`). */
export function decodeTitlePath(encoded: string): string[] {
  const segments: string[] = [];
  let current = '';
  for (let index = 0; index < encoded.length; index += 1) {
    const char = encoded[index]!;
    if (char === '\\') {
      const next = encoded[index + 1];
      if (next === '>' || next === '\\') {
        current += next;
        index += 1;
        continue;
      }
    }
    if (char === '>') {
      if (current.length > 0) segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Builds `<file>#<encoded title path>` (first `#` separates file only). */
export function runnerLogicalKey(file: string, titlePath: readonly string[]): string {
  return `${file}#${encodeTitlePath(titlePath)}`;
}

/** Parses a runner `<file>#<title path>` logical key. */
export function parseRunnerLogicalKey(logicalKey: string): { file: string; titlePath: string[] } {
  const hash = logicalKey.indexOf('#');
  if (hash <= 0) {
    return { file: hash === 0 ? '' : logicalKey, titlePath: [] };
  }
  return {
    file: logicalKey.slice(0, hash),
    titlePath: decodeTitlePath(logicalKey.slice(hash + 1)),
  };
}
