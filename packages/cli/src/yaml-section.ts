/**
 * TEXT-LEVEL writing of one top-level YAML section, for the documents the
 * CLI owns and the owner reviews: `gateforge migrate`, `gateforge
 * classify plane`, `gateforge init --planes` and `gateforge init --rules`.
 *
 * Why text and not re-serialization: `.gateforge/classification-policy.yml`
 * is an owner-authored review artifact. A `parse` → `stringify` round trip
 * destroys every comment, key order and quoting choice the owner made, and
 * the reasons next to each rule ARE the review record. So this writer
 * splices a rendered block into the existing TEXT and touches nothing else.
 *
 * The span it replaces comes from the PARSER, not from line scanning: the
 * `yaml` document node knows exactly where a top-level key's value ends, so
 * a comment at column zero inside the section, a `#` on the key's own line
 * and a trailing comment block after the section are all left where the
 * owner put them. Line scanning gets those wrong, and a wrong span silently
 * eats the owner's notes.
 *
 * Fail-closed three ways:
 *
 * 1. the input must parse as a YAML mapping (an existing section the writer
 *    cannot read as a mapping is REFUSED BY NAME, never overwritten);
 * 2. the rendered block is re-parsed and the section compared to what was
 *    asked for, so a rendering the parser reads differently fails before
 *    anything reaches disk;
 * 3. a document with the same top-level key twice is refused outright — the
 *    strict readers behind it reject it too, and guessing which one to
 *    replace would pick an answer nobody wrote.
 */
import {
  isCollection,
  isMap,
  isScalar,
  parseDocument,
  stringify as stringifyYaml,
} from 'yaml';
import { UsageError } from './errors.js';

/** The exact text span one top-level key occupies, as parser offsets. */
interface SectionSpan {
  /** Offset of the `key` token itself. */
  readonly start: number;
  /** Offset one past the section's last byte the writer replaces. */
  readonly end: number;
}

/** One top-level `key:` whose value the writer cannot read as a mapping. */
class UnreadableSection extends Error {}

/**
 * One top-level entry of a YAML mapping, reduced to what the span
 * computation needs.
 */
interface TopLevelPair {
  /** The key as text, exactly as the document spells it. */
  readonly name: string;
  /** Source offset of the `key` token; undefined when the parser has none. */
  readonly keyStart: number | undefined;
  /** The value node; null for a key that declares nothing. */
  readonly valueNode: unknown;
}

/**
 * Parses a document fail-closed, refusing anything that is not a YAML
 * mapping at the top level.
 *
 * @param text - the document's exact current text ('' for a new file).
 * @param key - the top-level key the caller intends to write, named in refusals.
 * @param path - repo-relative document path, named in refusals.
 * @returns every top-level entry, in document order.
 */
function topLevelPairs(text: string, key: string, path: string): TopLevelPair[] {
  const document = parseDocument(text === '' ? '{}\n' : text);
  if (document.errors.length > 0) {
    throw new UsageError(
      `${path} is not valid YAML, so nothing can be written into it: ` +
        `${document.errors[0]?.message.split('\n')[0] ?? 'parse error'}`,
    );
  }
  const contents = document.contents;
  if (contents === null || !isMap(contents)) {
    throw new UsageError(`${path} is not a YAML mapping, so ${key}: cannot be written into it`);
  }
  const seen = new Set<string>();
  const pairs: TopLevelPair[] = [];
  for (const pair of contents.items) {
    if (pair === null || pair === undefined || !isScalar(pair.key)) continue;
    const name = String(pair.key.value);
    if (seen.has(name)) {
      throw new UsageError(
        `${path} declares the top-level key '${name}' more than once; fix the document by hand ` +
          'before a command rewrites one of them',
      );
    }
    seen.add(name);
    pairs.push({ name, keyStart: pair.key.range?.[0], valueNode: pair.value });
  }
  return pairs;
}

/**
 * The end offset of a `key:` line that declares NO value — the one case a
 * scalar node cannot describe, because the parser gives an empty value a
 * zero-width range right after the colon.
 *
 * Text after the colon is consumed only up to a trailing comment, so an
 * owner's `# note` on the key's own line survives the write instead of
 * being deleted with the line it annotated.
 *
 * @param text - the document's exact text.
 * @param keyStart - offset of the `key` token.
 * @param key - the top-level key, named in refusals.
 * @param path - repo-relative document path, named in refusals.
 * @returns the offset one past the consumed text.
 */
function emptyValueEnd(text: string, keyStart: number, key: string, path: string): number {
  const newline = text.indexOf('\n', keyStart);
  const line = text.slice(keyStart, newline === -1 ? text.length : newline);
  const colon = line.indexOf(':');
  if (colon === -1) {
    throw new UnreadableSection(`${path}: '${line}' is not a \`key:\` line`);
  }
  const after = line.slice(colon + 1);
  const comment = after.search(/(^|\s)#/);
  const declared = (comment === -1 ? after : after.slice(0, comment)).trim();
  if (declared !== '') {
    throw new UnreadableSection(
      `${path} declares ${key} inline as \`${key}: ${declared}\`; this command only writes ` +
        `${key} as a mapping — edit the file by hand`,
    );
  }
  return keyStart + colon + 1 + (comment === -1 ? after.length : comment);
}

/**
 * Locates the exact span of one top-level `key:`.
 *
 * @param text - the document's exact text.
 * @param key - the top-level mapping key.
 * @param path - repo-relative document path, named in refusals.
 * @returns the span, or null when the document does not declare the key.
 * @throws UnreadableSection when the existing section is not a mapping.
 */
function sectionSpan(text: string, key: string, path: string): SectionSpan | null {
  for (const pair of topLevelPairs(text, key, path)) {
    if (pair.name !== key) continue;
    const start = pair.keyStart;
    if (start === undefined) {
      throw new UnreadableSection(`${path}: the parser located no source text for ${key}:`);
    }
    // A scalar here is an INLINE declaration (`planes: 5`, a block string).
    // The writer never guesses what a scalar meant; the owner edits it.
    if (isScalar(pair.valueNode)) {
      if (pair.valueNode.value !== null) {
        throw new UnreadableSection(
          `${path} declares ${key} inline as \`${key}: ${String(pair.valueNode.value).split('\n')[0]}\`; ` +
            `this command only writes ${key} as a mapping — edit the file by hand`,
        );
      }
      return { start, end: emptyValueEnd(text, start, key, path) };
    }
    if (!isCollection(pair.valueNode)) {
      throw new UnreadableSection(`${path}: the parser located no source text for ${key}:`);
    }
    const end = pair.valueNode.range?.[1];
    if (end === undefined) {
      throw new UnreadableSection(`${path}: the parser located no source text for ${key}:`);
    }
    return { start, end };
  }
  return null;
}

/**
 * Recursively orders object keys and drops undefined members, so two
 * structurally equal values compare equal as text.
 *
 * @param value - any parsed YAML value.
 * @returns a canonical text form.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(',')}}`;
}

/**
 * Renders one top-level section: `key:` plus a two-space-indented body. An
 * empty mapping renders inline (`key: {}`), so a written section never
 * leaves a dangling key behind.
 *
 * @param key - the top-level mapping key.
 * @param value - the plain-data section body.
 * @returns the rendered lines, without a trailing newline.
 */
function renderSection(key: string, value: unknown): string[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
    return [`${key}: {}`];
  }
  const body = stringifyYaml(value, { indent: 2, lineWidth: 0 }).replace(/\n$/, '');
  return [`${key}:`, ...body.split('\n').map((line) => (line === '' ? '' : `  ${line}`))];
}

/**
 * Replaces (or appends) one top-level section of a YAML document,
 * preserving every other byte — comments included.
 *
 * @param text - the document's exact current text ('' for a new file).
 * @param key - the top-level mapping key to own.
 * @param value - the exact plain-data body to declare.
 * @param path - repo-relative document path, named in refusals.
 * @returns the document text with the section written.
 * @throws UsageError on unparsable input, a duplicated or unreadable
 *   existing section, or a result that does not parse back to what was
 *   asked for.
 */
export function setTopLevelSection(text: string, key: string, value: unknown, path: string): string {
  let span: SectionSpan | null;
  try {
    span = sectionSpan(text, key, path);
  } catch (error) {
    if (error instanceof UnreadableSection) throw new UsageError(error.message);
    throw error;
  }
  const rendered = renderSection(key, value);
  let next: string;
  if (span === null) {
    const head = text.replace(/\n+$/, '');
    next = head === '' ? `${rendered.join('\n')}\n` : `${head}\n\n${rendered.join('\n')}\n`;
  } else {
    let before = text.slice(0, span.start);
    let after = text.slice(span.end);
    if (before !== '' && !before.endsWith('\n')) before += '\n';
    if (after !== '' && !after.startsWith('\n')) after = `\n${after}`;
    next = `${before}${rendered.join('\n')}${after}`;
  }
  // Fail closed: the block this writer produced must parse back to exactly
  // what was asked for, so no later reader ever sees a section that differs
  // from the one the command reported.
  const document = parseDocument(next);
  if (document.errors.length > 0) {
    throw new UsageError(
      `writing ${key} into ${path} produced invalid YAML and was refused: ` +
        `${document.errors[0]?.message.split('\n')[0] ?? 'parse error'}`,
    );
  }
  const written = (document.toJS() as Record<string, unknown>)[key];
  if (canonical(written) !== canonical(value)) {
    throw new UsageError(
      `writing ${key} into ${path} would not read back as the declared value; nothing was ` +
        'written — edit the file by hand',
    );
  }
  return next;
}

/**
 * Reports whether a YAML document declares a top-level section.
 *
 * @param text - the document's exact text.
 * @param key - the top-level mapping key.
 * @param path - repo-relative document path, named in refusals.
 * @returns true when the key is present at the top level.
 * @throws UsageError when the document does not parse or is not a mapping.
 */
export function declaresTopLevelSection(text: string, key: string, path: string): boolean {
  // An UNREADABLE existing section is still a declared section: the caller
  // only asks "does the owner have this answer?", and the answer is yes.
  // The writer that follows is the one that refuses by name.
  try {
    return sectionSpan(text, key, path) !== null;
  } catch (error) {
    if (error instanceof UnreadableSection) return true;
    throw error;
  }
}
