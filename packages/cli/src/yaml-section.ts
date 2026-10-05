/**
 * TEXT-LEVEL writing of ONE section of a YAML document, for the documents
 * the CLI owns and the owner reviews: `gateforge migrate`, `gateforge
 * classify plane`, `gateforge init --planes` and `gateforge init --rules`.
 *
 * Why text and not re-serialization: `.gateforge/classification-policy.yml`
 * is an owner-authored review artifact. A `parse` → `stringify` round trip
 * destroys every comment, key order and quoting choice the owner made, and
 * the reasons next to each rule ARE the review record. So this writer
 * splices a rendered block into the existing TEXT and touches nothing else.
 *
 * The span it replaces comes from the PARSER, not from line scanning: the
 * `yaml` document node knows exactly where a key's value ends, so a comment
 * at column zero inside the section, a `#` on the key's own line and a
 * trailing comment block after the section are all left where the owner put
 * them. Line scanning gets those wrong, and a wrong span silently eats the
 * owner's notes.
 *
 * Sections are addressed by PATH (`['scan', 'httpClients']`), not by a bare
 * key: `gateforge migrate` writes a nested section into `.gateforge.yml`
 * while leaving every sibling key of `scan:` exactly as the owner wrote it.
 *
 * Fail-closed four ways:
 *
 * 1. the input must parse as a YAML mapping (an existing section the writer
 *    cannot read as a mapping is REFUSED BY NAME, never overwritten);
 * 2. the rendered block is re-parsed and the section compared to what was
 *    asked for, so a rendering the parser reads differently fails before
 *    anything reaches disk;
 * 3. a document with the same key twice is refused outright — the strict
 *    readers behind it reject it too, and guessing which one to replace
 *    would pick an answer nobody wrote;
 * 4. {@link removeTopLevelSection} hands back the comment block that stood
 *    directly above the key it removed, so a caller that MOVES a key can
 *    carry the owner's note to its new home instead of dropping it.
 */
import {
  isCollection,
  isMap,
  isScalar,
  parseDocument,
  stringify as stringifyYaml,
} from 'yaml';
import { UsageError } from './errors.js';

/** The exact text span one section occupies, as parser offsets. */
interface SectionSpan {
  /** Offset of the `key` token itself. */
  readonly start: number;
  /** Offset one past the section's last byte the writer replaces. */
  readonly end: number;
}

/** One mapping entry the span computation needs. */
interface Pair {
  /** The key as text, exactly as the document spells it. */
  readonly name: string;
  /** Source offset of the `key` token; undefined when the parser has none. */
  readonly keyStart: number | undefined;
  /** The value node; null for a key that declares nothing. */
  readonly valueNode: unknown;
}

/** One `key:` whose value the writer cannot read as a mapping. */
class UnreadableSection extends Error {}

/** The comment block that stood directly above a removed key. */
export interface RemovedSection {
  /** The document text with the key and its comment block cut out. */
  readonly text: string;
  /** The comment lines, in document order, that documented the key. */
  readonly comments: readonly string[];
}

/**
 * The mapping entries of the document at `prefix`, in document order.
 *
 * @param text - the document's exact current text ('' for a new file).
 * @param prefix - the key path of the mapping to list (empty = top level).
 * @param key - the key the caller intends to write, named in refusals.
 * @param path - repo-relative document path, named in refusals.
 * @returns the entries, or null when the prefix does not exist.
 * @throws UsageError when the document or a prefix step is not a mapping.
 */
function pairsAt(
  text: string,
  prefix: readonly string[],
  key: string,
  path: string,
): Pair[] | null {
  const document = parseDocument(text === '' ? '{}\n' : text);
  if (document.errors.length > 0) {
    throw new UsageError(
      `${path} is not valid YAML, so nothing can be written into it: ` +
        `${document.errors[0]?.message.split('\n')[0] ?? 'parse error'}`,
    );
  }
  let contents: unknown = document.contents;
  if (contents === null || !isMap(contents)) {
    throw new UsageError(`${path} is not a YAML mapping, so ${key}: cannot be written into it`);
  }
  // Every prefix step must be a mapping the writer can read into: a scalar
  // or sequence there means the owner wrote something this writer has no
  // business reshaping, so it refuses by name.
  for (const step of prefix) {
    const pairs = mapPairs(contents as Parameters<typeof mapPairs>[0], step, path);
    const found = pairs.find((pair) => pair.name === step);
    if (found === undefined) return null;
    if (!isCollection(found.valueNode) || !isMap(found.valueNode)) {
      throw new UnreadableSection(
        `${path}: '${step}' is not a mapping, so ${[...prefix, key].join('.')} cannot be written into it`,
      );
    }
    contents = found.valueNode;
  }
  return mapPairs(contents as Parameters<typeof mapPairs>[0], key, path);
}

/**
 * The entries of one YAML mapping, refusing a duplicated key.
 *
 * @param contents - the mapping node to list.
 * @param key - the key the caller intends to write, named in refusals.
 * @param path - repo-relative document path, named in refusals.
 * @returns every entry, in document order.
 */
function mapPairs(contents: unknown, key: string, path: string): Pair[] {
  if (!isMap(contents)) {
    throw new UsageError(`${path} is not a YAML mapping, so ${key}: cannot be written into it`);
  }
  const seen = new Set<string>();
  const pairs: Pair[] = [];
  for (const pair of contents.items) {
    if (pair === null || pair === undefined || !isScalar(pair.key)) continue;
    const name = String(pair.key.value);
    if (seen.has(name)) {
      throw new UsageError(
        `${path} declares the key '${name}' more than once; fix the document by hand ` +
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
 * @param key - the key being written, named in refusals.
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
 * Locates the exact span of one section.
 *
 * @param text - the document's exact current text.
 * @param keyPath - the section's key path; its LAST element is the key.
 * @param path - repo-relative document path, named in refusals.
 * @returns the span, or null when the document does not declare the key.
 * @throws UnreadableSection when the existing section is not a mapping.
 */
function sectionSpan(text: string, keyPath: readonly string[], path: string): SectionSpan | null {
  const key = keyPath[keyPath.length - 1];
  if (key === undefined) {
    throw new UsageError(`${path}: a section needs at least one key`);
  }
  const pairs = pairsAt(text, keyPath.slice(0, -1), key, path);
  for (const pair of pairs ?? []) {
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

/** Indentation of a key at `depth`, counting the document root as 0. */
function indentOf(depth: number): string {
  return '  '.repeat(depth);
}

/**
 * Renders one section and every missing level above it: `key:` plus a body
 * indented one level deeper. An empty mapping renders inline
 * (`key: {}`), so a written section never leaves a dangling key behind.
 *
 * @param keyPath - the section's key path.
 * @param value - the plain-data section body.
 * @param comments - per-key comment lines carried along by a move.
 * @returns the rendered lines, without a trailing newline.
 */
function renderSection(
  keyPath: readonly string[],
  value: unknown,
  comments: ReadonlyMap<string, readonly string[]>,
): string[] {
  const key = keyPath[keyPath.length - 1];
  if (key === undefined) {
    throw new UsageError('a section needs at least one key');
  }
  const isEmptyMapping =
    value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  const leaf: string[] = isEmptyMapping
    ? [`${key}: {}`]
    : [
        `${key}:`,
        ...stringifyYaml(value, { indent: 2, lineWidth: 0 })
          .replace(/\n$/, '')
          .split('\n')
          .map((line) => (line === '' ? '' : `  ${line}`)),
      ];
  // The body of a nested section is indented twice: once for the parent key
  // it sits under, once for its own body.
  let lines: string[] = leaf;
  for (let depth = keyPath.length - 1; depth >= 1; depth -= 1) {
    const parent = keyPath[depth - 1];
    if (parent === undefined) continue;
    lines = [`${parent}:`, ...lines.map((line) => (line === '' ? '' : `  ${line}`))];
  }
  // Comments ride above their own key, at that key's indentation.
  const withComments = lines.flatMap((line) => {
    const depth = (line.length - line.trimStart().length) / 2;
    const name = line.trimStart().replace(/:.*$/, '');
    const note = comments.get(name);
    if (note === undefined || note.length === 0) return [line];
    return [...note.map((comment) => `${indentOf(depth)}${comment}`), line];
  });
  return withComments;
}

/**
 * {@link sectionSpan} with its internal refusal type turned into the
 * `UsageError` every caller of this module surfaces.
 *
 * @param text - the document's exact current text.
 * @param keyPath - the section's key path.
 * @param path - repo-relative document path, named in refusals.
 * @returns the span, or null when the document does not declare the key.
 * @throws UsageError naming the key the writer refuses to reshape.
 */
function sectionSpanOrRefuse(
  text: string,
  keyPath: readonly string[],
  path: string,
): SectionSpan | null {
  try {
    return sectionSpan(text, keyPath, path);
  } catch (error) {
    if (error instanceof UnreadableSection) throw new UsageError(error.message);
    throw error;
  }
}

/**
 * Replaces (or appends) one section of a YAML document, preserving every
 * other byte — comments included.
 *
 * @param text - the document's exact current text ('' for a new file).
 * @param keyPath - the section's key path (`['scan', 'httpClients']`).
 * @param value - the exact plain-data body to declare.
 * @param path - repo-relative document path, named in refusals.
 * @param comments - comment lines to place above their own key, for a
 *   caller moving a key and carrying the owner's note with it.
 * @returns the document text with the section written.
 * @throws UsageError on unparsable input, a duplicated or unreadable
 *   existing section, or a result that does not parse back to what was
 *   asked for.
 */
export function setSection(
  text: string,
  keyPath: readonly string[],
  value: unknown,
  path: string,
  comments: ReadonlyMap<string, readonly string[]> = new Map(),
): string {
  const key = keyPath[keyPath.length - 1];
  if (key === undefined) {
    throw new UsageError(`${path}: a section needs at least one key`);
  }
  const span = sectionSpanOrRefuse(text, keyPath, path);
  const rendered = renderSection(keyPath, value, comments);
  // The longest existing prefix of the path: where a missing section is
  // appended, and how deep its body must be indented.
  const existing = longestExistingPrefix(text, keyPath, path);
  const depth = existing?.length ?? 0;
  const indented = rendered.map((line) => (line === '' ? '' : `${indentOf(depth)}${line}`));
  let next: string;
  if (span !== null) {
    // The section exists: replace exactly its span, so every other byte of
    // the document — including a trailing comment block — is untouched.
    let before = text.slice(0, span.start);
    let after = text.slice(span.end);
    if (before !== '' && !before.endsWith('\n')) before += '\n';
    if (after !== '' && !after.startsWith('\n')) after = `\n${after}`;
    next = `${before}${rendered.join('\n')}${after}`;
  } else if (existing !== null) {
    // The parent exists but the leaf does not: append the new leaf INSIDE
    // the parent, at the parent's own indentation.
    const at = sectionSpanOrRefuse(text, existing, path)?.end ?? text.length;
    let before = text.slice(0, at);
    let after = text.slice(at);
    if (before !== '' && !before.endsWith('\n')) before += '\n';
    if (after !== '' && !after.startsWith('\n')) after = `\n${after}`;
    next = `${before}${indented.join('\n')}${after}`;
  } else {
    // Nothing of the path exists: append the whole rendered chain at the
    // end of the document, separated by one blank line.
    const head = text.replace(/\n+$/, '');
    next = head === '' ? `${indented.join('\n')}\n` : `${head}\n\n${indented.join('\n')}\n`;
  }
  // Fail closed: the block this writer produced must parse back to exactly
  // what was asked for, so no later reader ever sees a section that differs
  // from the one the command reported.
  const document = parseDocument(next);
  if (document.errors.length > 0) {
    throw new UsageError(
      `writing ${keyPath.join('.')} into ${path} produced invalid YAML and was refused: ` +
        `${document.errors[0]?.message.split('\n')[0] ?? 'parse error'}`,
    );
  }
  let read: unknown = document.toJS();
  for (const step of keyPath) {
    if (read === null || typeof read !== 'object' || !(step in read)) {
      throw new UsageError(
        `writing ${keyPath.join('.')} into ${path} would not read back as the declared value; ` +
          'nothing was written — edit the file by hand',
      );
    }
    read = (read as Record<string, unknown>)[step];
  }
  if (canonical(read) !== canonical(value)) {
    throw new UsageError(
      `writing ${keyPath.join('.')} into ${path} would not read back as the declared value; nothing was ` +
        'written — edit the file by hand',
    );
  }
  return next;
}

/**
 * The longest prefix of `keyPath` the document already declares as a
 * mapping, or null when the document declares none of it.
 *
 * @param text - the document's exact current text.
 * @param keyPath - the section's key path.
 * @param path - repo-relative document path, named in refusals.
 * @returns the declared prefix length, as a path.
 */
function longestExistingPrefix(
  text: string,
  keyPath: readonly string[],
  path: string,
): string[] | null {
  for (let length = keyPath.length - 1; length >= 1; length -= 1) {
    const candidate = keyPath.slice(0, length);
    if (sectionSpanOrRefuse(text, candidate, path) !== null) return candidate;
  }
  return null;
}

/**
 * Reports whether a YAML document declares a section.
 *
 * @param text - the document's exact text.
 * @param keyPath - the section's key path.
 * @param path - repo-relative document path, named in refusals.
 * @returns true when the key is present at every level of the path.
 * @throws UsageError when the document does not parse or is not a mapping.
 */
export function declaresSection(text: string, keyPath: readonly string[], path: string): boolean {
  // An UNREADABLE existing section is still a declared section: the caller
  // only asks "does the owner have this answer?", and the answer is yes.
  // The writer that follows is the one that refuses by name.
  try {
    return sectionSpan(text, keyPath, path) !== null;
  } catch (error) {
    if (error instanceof UnreadableSection) return true;
    throw error;
  }
}

/**
 * Cuts one TOP-LEVEL key out of a document, handing back the comment block
 * that stood directly above it.
 *
 * The block above a key is that key's documentation by YAML convention, so
 * a caller that moves the key elsewhere can carry the note to its new home
 * instead of leaving it to be read as the next key's.
 *
 * @param text - the document's exact current text.
 * @param key - the top-level key to remove.
 * @param path - repo-relative document path, named in refusals.
 * @returns the removal, or null when the document declares no such key.
 * @throws UsageError when the document does not parse or is not a mapping.
 */
export function removeTopLevelSection(text: string, key: string, path: string): RemovedSection | null {
  const span = sectionSpan(text, [key], path);
  if (span === null) return null;
  // Walk back from the key's own line over the contiguous comment lines
  // above it (and the blank line that separates them from the rest), so the
  // note travels with its key instead of being left to annotate the next.
  let start = text.lastIndexOf('\n', span.start - 1);
  start = start === -1 ? 0 : start + 1;
  const lines = text.slice(0, start).split('\n');
  // `slice` stops right after the previous newline, so the split ends on an
  // empty element that is not a line of the document — drop it before
  // walking back, or the walk stops on it instead of on a comment.
  if (lines[lines.length - 1] === '') lines.pop();
  const notes: string[] = [];
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last === undefined || !/^\s*#/.test(last)) break;
    notes.unshift(last.trim());
    lines.pop();
  }
  if (notes.length > 0) {
    // One blank line above the comment block belongs to it, not to whatever
    // precedes it.
    const blank = lines.pop();
    if (blank !== undefined && blank.trim() === '') start -= blank.length + 1;
    start -= notes.reduce((total, note) => total + note.length + 1, 0);
  }
  // Swallow exactly one blank line AFTER the removed block, so the removal
  // does not leave a double gap; every other blank line is the owner's.
  let end = span.end;
  const after = text.slice(end);
  const trailing = /^\n[ \t]*\n/.exec(after);
  if (trailing !== null) end += trailing[0].length - 1;
  return { text: `${text.slice(0, start)}${text.slice(end)}`, comments: notes };
}