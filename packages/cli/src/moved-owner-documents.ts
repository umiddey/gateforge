/**
 * The 0.10 owner-answer FILES that 0.11.0 folds into the two documents
 * the host already reads, and the one refusal that replaces reading them.
 *
 * 0.11 consolidation (plan 2026-10-05 §5 D0): every owner answer now lives
 * in `.gateforge/classification-policy.yml` (`planes`, `endpoints`) or in
 * `.gateforge.yml` under `scan:` (`httpClients`, `fastapi`). There is NO
 * dual read: a repository that still carries one of these files is refused
 * by name, with the command that moves it, because silently ignoring the
 * file would silently drop the owner's declaration and quietly change
 * what the engine is allowed to conclude.
 *
 * The refusal is shared by EVERY command that reaches the pipeline, and by
 * `gateforge migrate` itself — which reads the files deliberately, through
 * {@link movedOwnerDocumentsPresent} rather than this thrower.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from './errors.js';

/** Repo-relative location of the ONE owner-answers document (name kept by owner decision). */
export const OWNER_ANSWERS_PATH = '.gateforge/classification-policy.yml';

/** Repo-relative location of the machine-wide configuration document. */
export const GATEFORGE_CONFIG_PATH = '.gateforge.yml';

/**
 * One file that moved: where the bytes lived before 0.11.0, which document
 * holds them now, and which key they sit under. The migrator and the
 * refusal both read this table, so the two can never disagree about which
 * files are old or where they went.
 */
export interface MovedOwnerDocument {
  /** Repo-relative path the repository may still be carrying. */
  readonly path: string;
  /** The document the bytes live in now. */
  readonly destination: string;
  /** The key inside that document. */
  readonly section: string;
  /** One owner-facing sentence for the refusal. */
  readonly describe: string;
}

/**
 * Every pre-0.11 owner-answer file, in the order `gateforge migrate`
 * applies them (deterministic: the answers document first, then the two
 * scanner sections).
 */
export const MOVED_OWNER_DOCUMENTS: readonly MovedOwnerDocument[] = Object.freeze([
  {
    path: '.gateforge/planes.json',
    destination: OWNER_ANSWERS_PATH,
    section: 'planes',
    describe: 'plane rules become the `planes:` section of the owner-answers document',
  },
  {
    path: '.gateforge/endpoints.json',
    destination: OWNER_ANSWERS_PATH,
    section: 'endpoints',
    describe: 'endpoint capabilities become the `endpoints:` section of the owner-answers document',
  },
  {
    path: '.gateforge/http-clients.json',
    destination: GATEFORGE_CONFIG_PATH,
    section: 'scan.httpClients',
    describe: 'HTTP client-scan settings become `scan.httpClients` in .gateforge.yml',
  },
  {
    path: '.gateforge/fastapi.json',
    destination: GATEFORGE_CONFIG_PATH,
    section: 'scan.fastapi',
    describe: 'FastAPI import roots become `scan.fastapi` in .gateforge.yml',
  },
]);

/**
 * The pre-0.11 owner-answer files still present in the repository.
 *
 * Args:
 *   cwd: absolute repository root.
 *
 * Returns:
 *   MovedOwnerDocument[]: the moved documents that still exist, in table order.
 */
export function movedOwnerDocumentsPresent(cwd: string): MovedOwnerDocument[] {
  return MOVED_OWNER_DOCUMENTS.filter((document) =>
    existsSync(join(cwd, ...document.path.split('/'))),
  );
}

/**
 * Refuses a pre-0.11 owner-answer file instead of reading it (fail closed).
 *
 * Args:
 *   cwd: absolute repository root (the tree the caller is about to read).
 *
 * Returns:
 *   void: nothing when no moved file is present.
 *
 * Throws:
 *   UsageError: naming every file present, where its bytes go, and the
 *     command that moves them.
 */
export function rejectMovedOwnerDocuments(cwd: string): void {
  const present = movedOwnerDocumentsPresent(cwd);
  if (present.length === 0) return;
  const named = present
    .map((document) => `  ${document.path} — ${document.describe}`)
    .join('\n');
  throw new UsageError(
    `found ${String(present.length)} pre-0.11 owner-answer file(s) no command reads anymore:\n` +
      `${named}\n` +
      'run `gateforge migrate` (preview, then --confirm), then re-approve the policy digest ' +
      '(gateforge enforcement pin --pin-file <path> --confirm)',
  );
}