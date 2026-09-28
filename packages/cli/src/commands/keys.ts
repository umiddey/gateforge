/** Owner commands for creating, rotating, and retiring verifier keys. */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { parseArgs, stringFlag } from '../args.js';
import { resolveStateDir } from '../state.js';
import {
  assertExternalVerifierKeyPath,
  createVerifierKeyringFile,
  defaultVerifierKeyringPath,
  importEnvironmentVerifierKey,
  readSecureKeyring,
  retireVerifierKey,
  rotateVerifierKeyring,
  writeSecureKeyring,
} from '../verifier-keys.js';

/** Usage for the explicit verifier-key ceremony commands. */
export const KEYS_USAGE =
  'usage: gateforge key create [--file <external-path>] --confirm\n' +
  '       gateforge key import-env [--file <external-path>] --confirm\n' +
  '       gateforge key rotate [--file <external-path>] --confirm\n' +
  '       gateforge key retire [--file <external-path>] --key-id <id> --confirm\n' +
  '       Default: $XDG_CONFIG_HOME/gateforge/verifier-keyring.json (or ~/.config/...); owner-only.';

/** Runs one explicit key-ring owner operation. */
export function keysCommand(io: Io, argv: readonly string[]): number {
  const { options, positionals } = parseArgs(argv);
  if (options['help'] === true || positionals.length === 0) {
    writeLine(io.stdout, KEYS_USAGE);
    return options['help'] === true ? 0 : 2;
  }
  const operation = positionals[0];
  if (positionals.length !== 1 || !['create', 'import-env', 'rotate', 'retire'].includes(operation ?? '')) {
    throw new UsageError(`unknown key operation '${operation ?? ''}'`);
  }
  if (options['confirm'] !== true) {
    throw new UsageError(`key ${operation}: this changes verifier authority; repeat with --confirm after owner review`);
  }
  const file = stringFlag(options, 'file') ?? defaultVerifierKeyringPath(io.env);
  if (file.length === 0) throw new UsageError(`key ${operation}: --file cannot be empty`);
  const allowed = operation === 'retire' ? ['file', 'key-id', 'confirm', 'help'] : ['file', 'confirm', 'help'];
  for (const flag of Object.keys(options)) {
    if (!allowed.includes(flag)) throw new UsageError(`unknown key flag '--${flag}'`);
  }
  const path = assertExternalVerifierKeyPath(io.cwd, resolve(io.cwd, file), io.env, [resolveStateDir(io.cwd)]);
  const keyId = stringFlag(options, 'key-id');
  if (operation === 'create') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) throw new UsageError(`key create: refusing to overwrite existing file '${path}'`);
    const created = createVerifierKeyringFile(path);
    writeLine(io.stdout, `verifier key ring created; active key id: ${created.keyId}; secret not displayed`);
    return 0;
  }
  if (!existsSync(path)) throw new UsageError(`key ${operation}: verifier key ring does not exist at '${path}'`);
  const document = readSecureKeyring(path);
  if (operation === 'rotate') {
    const rotated = rotateVerifierKeyring(document);
    writeSecureKeyring(path, rotated.document);
    writeLine(io.stdout, `verifier key rotated; active key id: ${rotated.keyId}; previous keys retained`);
    return 0;
  }
  if (operation === 'import-env') {
    const environmentKey = io.env['GATEFORGE_WITNESS_VERIFIER_KEY'];
    if (typeof environmentKey !== 'string' || environmentKey.length === 0) {
      throw new UsageError('key import-env: GATEFORGE_WITNESS_VERIFIER_KEY is required');
    }
    const imported = importEnvironmentVerifierKey(document, environmentKey);
    writeSecureKeyring(path, imported.document);
    writeLine(io.stdout, `environment key retained as id ${imported.keyId}; secret not displayed`);
    return 0;
  }
  if (keyId === undefined || keyId.length === 0) throw new UsageError('key retire: --key-id is required');
  const retired = retireVerifierKey(document, keyId);
  writeSecureKeyring(path, retired);
  writeLine(io.stdout, `verifier key retired: ${keyId}; active key unchanged`);
  return 0;
}
