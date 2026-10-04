/**
 * Text-level writing of `evidence.exclude` into `.gateforge.yml`.
 *
 * The owner's YAML is never re-serialized: an insertion splices lines
 * into the existing text, so every comment, key order, quoting style and
 * hand-written edit survives byte for byte. Only the inserted block is
 * new. This is the same discipline 0.9.2 applies to `classify delete`'s
 * `deleteRules` writer (re-implemented here so this branch carries no
 * dependency on that line).
 *
 * Everything this writes is re-parsed against the pinned schema before
 * it is returned: a text edit that would produce a document this
 * release cannot read back is refused, never written.
 */
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '@gate-forge/core';
import { UsageError } from './errors.js';

/** The two lists this writer owns, in the order the schema declares them. */
const KEYS = ['docs', 'cache'] as const;

/** One list to set; an absent key is left exactly as the owner wrote it. */
export type EvidenceExcludeLists = { [K in (typeof KEYS)[number]]?: readonly string[] };

/** A located `key:` line and the span of the block it owns. */
interface KeyBlock {
  /** Index of the `key:` line itself. */
  readonly at: number;
  /** Everything after the colon on that line (already trimmed). */
  readonly value: string;
  /** Index just past the last line belonging to this key's block. */
  readonly end: number;
}


/**
 * Reports whether the document already declares one evidence list, so a
 * caller can tell "never declared" from "declared empty" — the
 * difference between "no owner review needed" and "the owner is changing
 * an approved list".
 *
 * Args:
 *   text: the owner's `.gateforge.yml` content.
 *   key: `docs` or `cache`.
 *
 * Returns:
 *   boolean: true when `evidence.exclude.<key>` is present.
 */
export function declaresEvidenceExclude(text: string, key: (typeof KEYS)[number]): boolean {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return findKeyBlock(lines, 'evidence', '') !== null && findKeyBlock(lines, 'exclude', '  ') !== null &&
    findKeyBlock(lines, key, '    ') !== null;
}

/**
 * Locates `key:` at exactly `indent` columns.
 *
 * A blank line, a deeper line and a shallower line all end the search:
 * YAML gives the key's block to the following lines, so the first line
 * that is not part of it starts the next key.
 *
 * Args:
 *   lines: document split on newlines.
 *   key: the mapping key to find.
 *   indent: exact leading-whitespace string the key is nested under.
 *
 * Returns:
 *   KeyBlock | null: the located key, or null when absent.
 */
function findKeyBlock(lines: readonly string[], key: string, indent: string): KeyBlock | null {
  const prefix = `${indent}${key}:`;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    // `docs:` owns the rest of the line only when nothing but whitespace
    // or a comment follows; anything else is a key named `docs: x`.
    if (rest.length > 0 && !rest.startsWith(' ') && !rest.startsWith('\t')) continue;
    let end = index + 1;
    while (end < lines.length) {
      const candidate = lines[end] ?? '';
      if (candidate.trim() === '') {
        end += 1;
        continue;
      }
      if (candidate.length - candidate.trimStart().length <= indent.length) break;
      end += 1;
    }
    // Trailing blank lines belong to whatever comes next, not to this key.
    let blockEnd = end;
    while (blockEnd > index + 1 && (lines[blockEnd - 1] ?? '').trim() === '') blockEnd -= 1;
    return { at: index, value: rest.replace(/\s+#.*$/, '').trim(), end: blockEnd };
  }
  return null;
}

/** Renders a list key and its items at the given indent. */
function renderList(key: string, indent: string, values: readonly string[]): string[] {
  if (values.length === 0) return [`${indent}${key}: []`];
  return [`${indent}${key}:`, ...values.map((value) => `${indent}  - ${JSON.stringify(value)}`)];
}

/**
 * Replaces (or inserts) one list inside a located parent block.
 *
 * An existing list is REPLACED, which is what an owner-confirmed change
 * means; an inline value the writer cannot read as a plain list is
 * refused by name instead of being overwritten.
 *
 * Args:
 *   lines: document split on newlines (the caller joins it back).
 *   parent: the block that owns `key`.
 *   parentIndent: the parent's indent string.
 *   key: the list key to set.
 *   values: the exact list to declare.
 *   path: repo-relative document path, named in refusals.
 *
 * Returns:
 *   string[]: the spliced lines.
 */
function setListWithin(
  lines: readonly string[],
  parent: KeyBlock,
  parentIndent: string,
  key: string,
  values: readonly string[],
  path: string,
): string[] {
  const childIndent = `${parentIndent}  `;
  const existing = findKeyBlock(lines, key, childIndent);
  if (existing === null) {
    return [...lines.slice(0, parent.end), ...renderList(key, childIndent, values), ...lines.slice(parent.end)];
  }
  if (existing.value !== '' && existing.value !== '[]') {
    throw new UsageError(
      `${path} declares ${key} inline as \`${key}: ${existing.value}\`; this command only writes ` +
        `${key} as a list — edit the file by hand`,
    );
  }
  const nonBlank = lines.slice(existing.at + 1, existing.end).filter((line) => line.trim() !== '');
  if (!nonBlank.every((line) => /^\s*-\s/.test(line))) {
    throw new UsageError(
      `${path} has a ${key} value that is not a list of entries; edit it by hand — ` +
        'this command only writes `- ` items',
    );
  }
  // An inline `[]` and a block list are both a list; both are replaced by
  // the requested one. A trailing comment on the key line survives.
  const keyLine = lines[existing.at] ?? '';
  const rendered = renderList(key, childIndent, values);
  const comment = keyLine.indexOf('#');
  if (comment !== -1) rendered[0] = `${rendered[0] ?? ''} ${keyLine.slice(comment)}`;
  return [...lines.slice(0, existing.at), ...rendered, ...lines.slice(existing.end)];
}

/**
 * Sets `evidence.exclude.docs` / `.cache` in `.gateforge.yml` text.
 *
 * Absent lists are inserted; present lists are replaced exactly; an
 * `evidence:` or `exclude:` block this writer cannot extend safely (an
 * inline mapping, a non-list value, an unknown nesting) is refused by
 * name. The result is re-parsed against the pinned schema and its
 * `evidence.exclude` must equal what was asked for, so a hand-rolled
 * text edit that would parse into something else never leaves here.
 *
 * Args:
 *   text: the owner's `.gateforge.yml` content.
 *   lists: the lists to set; an absent key is left untouched.
 *   path: repo-relative document path, named in refusals.
 *
 * Returns:
 *   string: the new document text (byte-identical outside the edit).
 *
 * Throws:
 *   UsageError: an unextendable document, or a result that does not
 *   read back as the requested declarations.
 */
export function setEvidenceExclude(
  text: string,
  lists: EvidenceExcludeLists,
  path: string,
): string {
  const requested = KEYS.filter((key) => lists[key] !== undefined);
  let lines = text.length === 0 ? [] : text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  const evidence = findKeyBlock(lines, 'evidence', '');
  if (evidence !== null && evidence.value !== '') {
    throw new UsageError(
      `${path} declares evidence inline; this command only appends to an \`evidence:\` block — edit the file by hand`,
    );
  }
  if (evidence === null) {
    // Absent key: append a new top-level block. A document that ends
    // inside an indented block gets one blank line first, so the new key
    // cannot be read as part of that block.
    const last = lines[lines.length - 1] ?? '';
    const separator = last !== '' && /^\s/.test(last) ? [''] : [];
    lines = [...lines, ...separator, 'evidence:', '  exclude:'];
  }
  const evidenceBlock = findKeyBlock(lines, 'evidence', '');
  if (evidenceBlock === null) throw new UsageError(`${path} has no \`evidence:\` block after insertion`);
  const excludeBlock = findKeyBlock(lines, 'exclude', '  ');
  if (excludeBlock !== null && excludeBlock.value !== '') {
    throw new UsageError(
      `${path} declares evidence.exclude inline as \`exclude: ${excludeBlock.value}\`; this command only ` +
        'appends to an `exclude:` block — edit the file by hand',
    );
  }
  if (excludeBlock === null) {
    lines = [...lines.slice(0, evidenceBlock.end), '  exclude:', ...lines.slice(evidenceBlock.end)];
  }
  for (const key of requested) {
    // The block is re-located per key: the previous insertion moved the
    // lines an earlier `end` index pointed at, and the second list must
    // land after the first one, in the order the schema declares them.
    const exclude = findKeyBlock(lines, 'exclude', '  ');
    if (exclude === null) throw new UsageError(`${path} has no \`evidence.exclude:\` block after insertion`);
    lines = setListWithin(lines, exclude, '  ', key, lists[key] ?? [], path);
  }
  const after = `${lines.join('\n')}\n`;
  // Schema self-check: this release must be able to read back exactly
  // what it wrote, before anything writes it.
  let parsed;
  try {
    parsed = parseConfig(parseYaml(after), { file: path });
  } catch (error) {
    throw new UsageError(
      `refusing to write a '${path}' this release cannot read back: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const key of requested) {
    const written = parsed.evidence?.exclude?.[key] ?? [];
    const expected = [...(lists[key] ?? [])];
    if (JSON.stringify(written) !== JSON.stringify(expected)) {
      throw new UsageError(
        `refusing to write a '${path}' whose evidence.exclude.${key} would read back as ` +
          `${JSON.stringify(written)} instead of ${JSON.stringify(expected)}`,
      );
    }
  }
  return after;
}

/**
 * Splits config text into comparable lines without a synthetic tail.
 *
 * Args:
 *   text: reviewed config content.
 *
 * Returns:
 *   string[]: config lines with line endings removed.
 */
function configLines(text: string): string[] {
  if (text.length === 0) return [];
  const result = text.replace(/\r\n/g, '\n').split('\n');
  if (result[result.length - 1] === '') result.pop();
  return result;
}

/**
 * Formats an exact line-level diff between two config texts.
 *
 * Args:
 *   path: repo-relative config path.
 *   before: existing config contents, or an empty string if absent.
 *   after: proposed config contents.
 *
 * Returns:
 *   string: a unified diff showing every changed line.
 */
export function configTextDiff(path: string, before: string, after: string): string {
  const oldLines = configLines(before);
  const newLines = configLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const oldStart = removed.length === 0 ? prefix : prefix + 1;
  const newStart = added.length === 0 ? prefix : prefix + 1;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${removed.length} +${newStart},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join('\n');
}
