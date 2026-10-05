/**
 * The `gateforge migrate` steps that fold the 0.10 owner-answer FILES into
 * the two documents 0.11.0 reads.
 *
 * One step per moved file, each reading the old bytes deliberately and
 * writing them as TEXT into their new home:
 *
 * - `.gateforge/planes.json` / `.gateforge/endpoints.json` become the
 *   `planes:` / `endpoints:` SECTIONS of `.gateforge/classification-policy.yml`;
 * - `.gateforge/http-clients.json` / `.gateforge/fastapi.json` become
 *   `scan.httpClients` / `scan.fastapi` in `.gateforge.yml`;
 * - the four scanner keys move OUT of the answers document into `scan:`.
 *
 * Why a text splice and not a re-serialization: the answers document is an
 * owner-authored review artifact whose comments and reasons ARE the review
 * record, and the comment above a moved key travels with it
 * ({@link removeTopLevelSection} hands it back for exactly that reason).
 *
 * Every old value is validated by the SAME reader that will read it after
 * the move, BEFORE anything is written: a file whose contents the new home
 * would reject is refused here, with the file named, instead of producing a
 * repository that cannot run.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FastapiScanSectionSchema,
  HttpClientsScanSectionSchema,
  isMovedScannerKey,
  ScanConfigSchema,
  type PreMigrationConfig,
  type ScanConfig,
} from '@gate-forge/core';
import { parsePlanesConfigDocument } from '@gate-forge/pack-sqlalchemy';
import { parse as parseYaml } from 'yaml';
import { UsageError } from '../errors.js';
import { parseEndpointsConfigDocument } from '../endpoint-config.js';
import { configTextDiff } from '../evidence-config-text.js';
import { movedOwnerDocumentsPresent } from '../moved-owner-documents.js';
import { declaresSection, removeTopLevelSection, setSection } from '../yaml-section.js';

/** What one migration step found, before anything is written. */
export interface MigrationStep {
  /** Stable id, printed in the preview and on success. */
  readonly id: string;
  /** One owner-facing line describing what changes. */
  readonly describe: string;
  /** Repo-relative files this step deletes once its rewrite lands. */
  readonly removals: readonly string[];
  /** The preview diff, one line per added/removed text line. */
  readonly diff: string;
  /** Applies the rewrite, then deletes the old files. */
  apply(cwd: string): void;
}

/**
 * The scanner settings as the repository will read them once every
 * migration step is applied.
 *
 * This is the composition every run performs, run EARLY so that everything
 * downstream — the exclusion validators, which refuse to hide a declared
 * gate input — validates against the config the migration will produce and
 * not against the half-migrated one on disk.
 *
 * @param cwd - absolute repository root.
 * @param config - the pre-0.11 config (its `scan:` is absent or partial).
 * @returns the composed scanner settings.
 * @throws UsageError when no `scan:` can be composed — a repository with
 *   no scanner answer anywhere cannot be migrated, and inventing one would
 *   write a scan scope the owner never wrote.
 */
export function composeScanSection(cwd: string, config: PreMigrationConfig): ScanConfig {
  const answersPath = config.classificationPolicy;
  const absolute = join(cwd, ...answersPath.split('/'));
  const answersText = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  const fromAnswers = readMovedScannerKeys(answersText, answersPath);
  const declared = readMovedScannerKeys(
    readFileSync(join(cwd, '.gateforge.yml'), 'utf8'),
    '.gateforge.yml',
    'scan',
  );
  const merged: Record<string, unknown> = { ...config.scan, ...declared, ...fromAnswers };
  const parsed = ScanConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new UsageError(
      'this repository declares no complete `scan:` section, so there is nothing to migrate ' +
        'into: add `scanRoots`, `declarations` and `volatileFields` to .gateforge.yml by hand ' +
        `(first missing: ${parsed.error.issues[0]?.path.join('.') ?? 'scan'})`,
    );
  }
  return parsed.data;
}

/**
 * The scanner keys a document declares under its own top level (or under
 * `prefix`), as raw values — this reader never validates them: the caller
 * composes and then validates the whole section once.
 *
 * @param text - the document's exact text.
 * @param path - repo-relative document path, named in refusals.
 * @param prefix - the section the keys live under, when not top level.
 * @returns the raw moved-key values found.
 */
function readMovedScannerKeys(
  text: string,
  path: string,
  prefix?: string,
): Record<string, unknown> {
  let document: unknown;
  try {
    document = parseYaml(text) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split('\n')[0] ?? '' : String(cause);
    throw new UsageError(`${path} is not valid YAML, so nothing was migrated: ${detail}`);
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return {};
  const top = document as Record<string, unknown>;
  const scope =
    prefix === undefined
      ? top
      : top[prefix] !== null && typeof top[prefix] === 'object' && !Array.isArray(top[prefix])
        ? (top[prefix] as Record<string, unknown>)
        : {};
  const keys: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(scope)) {
    if (isMovedScannerKey(key)) keys[key] = value;
  }
  return keys;
}

/**
 * Reads one moved JSON document, failing closed on unreadable bytes.
 *
 * @param cwd - absolute repository root.
 * @param relative - repo-relative path of the old file.
 * @returns the parsed document.
 * @throws UsageError naming the file when its bytes are not valid JSON.
 */
function readMovedJson(cwd: string, relative: string): unknown {
  const absolute = join(cwd, ...relative.split('/'));
  if (!existsSync(absolute)) {
    throw new UsageError(`${relative} disappeared between planning and reading it`);
  }
  try {
    return JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split('\n')[0] ?? '' : String(cause);
    throw new UsageError(`${relative} is not valid JSON, so nothing was migrated: ${detail}`);
  }
}

/**
 * Writes a document through a sibling temporary file, so an interrupted
 * migrate never leaves a half-written owner artifact behind.
 *
 * @param cwd - absolute repository root.
 * @param relative - repo-relative target path.
 * @param text - the exact content to write.
 */
function writeDocument(cwd: string, relative: string, text: string): void {
  const absolute = join(cwd, ...relative.split('/'));
  const temporary = `${absolute}.gateforge-migrate.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', encoding: 'utf8' });
    renameSync(temporary, absolute);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

/** One step that deletes one old file after its rewrite landed. */
function stepWithRemoval(
  id: string,
  describe: string,
  diff: string,
  removal: string,
  write: (cwd: string) => void,
): MigrationStep {
  return {
    id,
    describe,
    removals: [removal],
    diff,
    apply: (cwd: string) => {
      write(cwd);
      const absolute = join(cwd, ...removal.split('/'));
      if (existsSync(absolute)) unlinkSync(absolute);
    },
  };
}

/**
 * The section body a moved file declares, validated by the SAME reader
 * that will read it after the move.
 *
 * @param section - the answers-document section key the file becomes.
 * @param parsed - the old file's parsed JSON.
 * @param relative - repo-relative path of the old file, named in refusals.
 * @returns the validated section body.
 * @throws UsageError naming the file when the body would be refused.
 */
function validatedSection(section: string, parsed: unknown, relative: string): unknown {
  try {
    return section === 'planes'
      ? parsePlanesConfigDocument(parsed, relative)
      : parseEndpointsConfigDocument(parsed, relative);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new UsageError(`${relative} would not be readable in its new home: ${detail}`);
  }
}

/**
 * Every pre-0.11 owner-answer file still on disk becomes one migration
 * step, in the order they are applied.
 *
 * @param cwd - absolute repository root.
 * @param config - the pre-0.11 config, read leniently (no `scan:` yet).
 * @returns one step per moved file present, answers document first.
 * @throws UsageError naming the offending file when a document's bytes
 *   would not validate in their new home, or when two owner documents
 *   answer the same fact differently.
 */
export function movedDocumentSteps(cwd: string, config: PreMigrationConfig): MigrationStep[] {
  const present = movedOwnerDocumentsPresent(cwd);
  if (present.length === 0) return [];
  const answersPath = config.classificationPolicy;
  const answersAbsolute = join(cwd, ...answersPath.split('/'));
  const answersBefore = existsSync(answersAbsolute) ? readFileSync(answersAbsolute, 'utf8') : '';
  if (!existsSync(answersAbsolute)) {
    throw new UsageError(
      `${answersPath} is absent, so the plane and endpoint answers have nowhere to go — run ` +
        '`gateforge init` first, then rerun `gateforge migrate`',
    );
  }
  const configPath = '.gateforge.yml';
  const configBefore = readFileSync(join(cwd, configPath), 'utf8');

  // The two JSON documents that become `planes:` / `endpoints:` sections.
  // Both write the SAME document, so their steps compose onto one running
  // text: the second must see what the first wrote, or the second write
  // would silently drop the first section.
  let answersRunning = answersBefore;
  const answersSteps = present
    .filter((document) => document.destination === answersPath)
    .map((document) => {
      const parsed = readMovedJson(cwd, document.path);
      // Validate through the SAME reader that will read the section after
      // the move: a file whose bytes the new home refuses is refused here,
      // with the file named, instead of producing a repository that cannot
      // load.
      const body = validatedSection(document.section, parsed, document.path);
      if (declaresSection(answersRunning, [document.section], answersPath)) {
        throw new UsageError(
          `${answersPath} already declares a \`${document.section}:\` section, so migrating ` +
            `${document.path} would overwrite an answer the owner already made — delete or ` +
            'merge it by hand',
        );
      }
      const before = answersRunning;
      const after = setSection(before, [document.section], body, answersPath);
      answersRunning = after;
      return stepWithRemoval(
        `${document.section}-section`,
        `${document.path} becomes the \`${document.section}:\` section of ${answersPath}`,
        configTextDiff(answersPath, before, after),
        document.path,
        (repoRoot) => {
          writeDocument(repoRoot, answersPath, after);
        },
      );
    });

  // The two detector documents that become `scan:` subsections. Both live
  // in `.gateforge.yml`, so their steps compose onto the SAME running text:
  // the second must see what the first wrote.
  let configRunning = configBefore;
  const scanSteps = present
    .filter((document) => document.destination === configPath)
    .map((document) => {
      const key = document.section.split('.')[1] ?? document.section;
      const parsed = readMovedJson(cwd, document.path);
      const schema = key === 'httpClients' ? HttpClientsScanSectionSchema : FastapiScanSectionSchema;
      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        throw new UsageError(
          `${document.path} does not validate as \`scan.${key}\`, so nothing was migrated: ` +
            `${validated.error.issues[0]?.message ?? 'invalid document'}`,
        );
      }
      const before = configRunning;
      const after = setSection(before, ['scan', key], validated.data, configPath);
      configRunning = after;
      return stepWithRemoval(
        `scan-${key}`,
        `${document.path} becomes \`scan.${key}\` in ${configPath}`,
        configTextDiff(configPath, before, after),
        document.path,
        (repoRoot) => {
          writeDocument(repoRoot, configPath, after);
        },
      );
    });

  const scannerStep = scannerKeysStep(cwd, answersPath, answersRunning, configRunning);
  return [...answersSteps, ...scanSteps, ...(scannerStep === null ? [] : [scannerStep])];
}

/**
 * The step that moves the four scanner keys OUT of the answers document
 * and into `scan:` in `.gateforge.yml`, or null when the answers document
 * declares none of them.
 *
 * @param cwd - absolute repository root.
 * @param answersPath - repo-relative path of the answers document.
 * @param answersBefore - the answers document's exact current text.
 * @param configText - `.gateforge.yml` as the earlier steps left it.
 * @returns the step, or null when there is nothing to move.
 * @throws UsageError when a key the config already declares under `scan:`
 *   disagrees with the one the answers document carries, or when the
 *   composed section would not satisfy the schema a run validates.
 */
function scannerKeysStep(
  cwd: string,
  answersPath: string,
  answersBefore: string,
  configText: string,
): MigrationStep | null {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = parseYaml(answersBefore) as Record<string, unknown> | null;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split('\n')[0] ?? '' : String(cause);
    throw new UsageError(`${answersPath} is not valid YAML, so nothing was migrated: ${detail}`);
  }
  const moved = (parsed === null ? [] : Object.keys(parsed))
    .filter((key) => isMovedScannerKey(key))
    .sort();
  if (moved.length === 0) return null;
  const existingScan =
    (parseYaml(configText) as { scan?: Record<string, unknown> } | null)?.scan ?? {};
  const section: Record<string, unknown> = {};
  // A key already migrated into `scan:` is skipped ONLY when it agrees; a
  // disagreement is two owner documents answering the same fact and is
  // refused by name rather than resolved by precedence.
  for (const key of moved) {
    const value = parsed?.[key];
    const present = existingScan[key];
    if (present !== undefined && JSON.stringify(present) !== JSON.stringify(value)) {
      throw new UsageError(
        `${answersPath} declares \`${key}\` and ${'.gateforge.yml'} already declares a different ` +
          `\`scan.${key}\` — two answers to one fact. Fix one by hand, then rerun migrate`,
      );
    }
    if (present !== undefined) continue;
    section[key] = value;
  }
  if (Object.keys(section).length === 0) return null;
  // The composed `scan:` must satisfy the SAME schema a run validates, so
  // a migrated repository that still cannot load is impossible.
  const composed = ScanConfigSchema.safeParse({ ...existingScan, ...section });
  if (!composed.success) {
    throw new UsageError(
      `moving ${moved.join(', ')} into \`scan:\` in .gateforge.yml would produce a section that ` +
        `fails the schema a run validates, so nothing was migrated: ` +
        `${composed.error.issues[0]?.message ?? 'invalid section'}`,
    );
  }
  // Cut the moved keys out of the answers document, carrying each key's
  // own comment block to its new home.
  let answersAfter = answersBefore;
  const carried = new Map<string, readonly string[]>();
  for (const key of moved) {
    const removal = removeTopLevelSection(answersAfter, key, answersPath);
    if (removal === null) continue;
    answersAfter = removal.text;
    if (removal.comments.length > 0) carried.set(key, removal.comments);
  }
  const configAfter = setSection(configText, ['scan'], composed.data, '.gateforge.yml', carried);
  return {
    id: 'scanner-settings',
    describe: `${moved.join(', ')} move from ${answersPath} into \`scan:\` in .gateforge.yml`,
    removals: [],
    diff: [
      configTextDiff('.gateforge.yml', configText, configAfter),
      configTextDiff(answersPath, answersBefore, answersAfter),
    ].join('\n'),
    apply: (repoRoot: string) => {
      writeDocument(repoRoot, '.gateforge.yml', configAfter);
      writeDocument(repoRoot, answersPath, answersAfter);
    },
  };
}