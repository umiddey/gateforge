/**
 * Trusted verifier-key sources and rotation helpers.
 *
 * Secrets come from the protected environment or an owner-only external
 * key-ring file. Candidate files and run artifacts are never key sources.
 */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { GateReceiptSchema, verifyGateReceipt } from '@gate-forge/core';
import { UsageError } from './errors.js';
import { resolveGitDir } from './candidate-tree.js';
import { resolveStateDir } from './state.js';
import { VERIFIER_KEY_ENV, VERIFIER_KEY_FILE_ENV } from './commands/common.js';

/** One key in the trusted verifier ring. */
export interface VerifierKeyMaterial {
  /** Non-secret key identifier stored in new receipts. */
  keyId: string;
  /** Secret HMAC key. Never write this value to run state or logs. */
  key: string;
}

/** Active key plus every retained verification key. */
export interface VerifierKeyring {
  /** Key that signs new witness records and receipts. */
  active: VerifierKeyMaterial;
  /** Active and retained old keys, in active-first order. */
  keys: readonly VerifierKeyMaterial[];
}

/** Serialized external key-ring format. */
export interface VerifierKeyringDocument {
  schemaVersion: 1;
  activeKeyId: string;
  keys: Record<string, string>;
}

/** Result of verifying a receipt with a retained key ring. */
export type KeyringReceiptVerification =
  | ReturnType<typeof verifyGateReceipt>
  | { ok: false; rejection: 'key-unknown' | 'key-mismatch'; detail: string };

const KEY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Returns the stable non-secret identifier used for an environment key. */
export function environmentVerifierKeyId(key: string): string {
  return `env-${createHash('sha256').update('gateforge.verifier-key-id.v1\0').update(key).digest('hex').slice(0, 24)}`;
}

/** Resolves the trusted key source and rejects any source inside candidate artifacts. */
export function resolveVerifierKeyring(
  cwd: string,
  env: NodeJS.ProcessEnv,
  additionalArtifactRoots: readonly string[] = [],
): VerifierKeyring | null {
  const environmentKey = env[VERIFIER_KEY_ENV];
  const keyFile = env[VERIFIER_KEY_FILE_ENV];
  if (typeof environmentKey === 'string' && environmentKey.length > 0 && typeof keyFile === 'string' && keyFile.length > 0) {
    throw new UsageError(
      `set only one verifier-key source: ${VERIFIER_KEY_ENV} or ${VERIFIER_KEY_FILE_ENV}`,
    );
  }
  if (typeof environmentKey === 'string' && environmentKey.length > 0) {
    const active = { keyId: environmentVerifierKeyId(environmentKey), key: environmentKey };
    return { active, keys: [active] };
  }
  if (typeof keyFile !== 'string' || keyFile.length === 0) return null;

  const path = resolve(cwd, keyFile);
  assertExternalVerifierKeyPath(cwd, path, env, additionalArtifactRoots);
  const document = readSecureKeyring(path);
  const keys = Object.entries(document.keys).map(([keyId, key]) => ({ keyId, key }));
  const active = keys.find((entry) => entry.keyId === document.activeKeyId);
  if (active === undefined) throw new UsageError('verifier key ring has no active key');
  return { active, keys: [active, ...keys.filter((entry) => entry.keyId !== active.keyId)] };
}

/** Checks that a key path stays outside candidate, Git, state, and artifact roots. */
export function assertExternalVerifierKeyPath(
  cwd: string,
  keyPath: string,
  env: NodeJS.ProcessEnv,
  additionalArtifactRoots: readonly string[] = [],
): string {
  if (process.platform === 'win32' || constants.O_NOFOLLOW === undefined) {
    throw new UsageError(
      'verifier key files need POSIX owner and mode checks with no-follow open; use a protected environment or a supported secret provider on this platform',
    );
  }
  const absolutePath = resolve(cwd, keyPath);
  const canonicalPath = canonicalizePath(absolutePath);
  const protectedRoots = [
    cwd,
    resolveGitDir(cwd, env) ?? '',
    resolveStateDir(cwd),
    ...additionalArtifactRoots,
  ].filter((root) => root !== '');
  for (const root of protectedRoots) {
    const canonicalRoot = canonicalizePath(resolve(root));
    if (isWithin(canonicalRoot, canonicalPath)) {
      throw new UsageError(
        `verifier key file must be outside the candidate repository, Git directory, run state, and uploaded artifact roots: '${absolutePath}'`,
      );
    }
  }
  return absolutePath;
}

/** Verifies a receipt with the identified key or any retained key for older receipts. */
export function verifyGateReceiptWithKeyring(
  keyring: VerifierKeyring,
  candidate: unknown,
  expected: Parameters<typeof verifyGateReceipt>[2] = {},
): KeyringReceiptVerification {
  const parsed = GateReceiptSchema.safeParse(candidate);
  if (!parsed.success) return verifyGateReceipt(keyring.active.key, candidate, expected);
  const receiptKeyId = parsed.data.verifierKeyId;
  if (receiptKeyId !== undefined) {
    const selected = keyring.keys.find((entry) => entry.keyId === receiptKeyId);
    if (selected === undefined) {
      return {
        ok: false,
        rejection: 'key-unknown',
        detail: `KEY_UNKNOWN: verifier key '${receiptKeyId}' is not in the trusted key ring`,
      };
    }
    const result = verifyGateReceipt(selected.key, candidate, expected);
    return result.ok || result.rejection !== 'mac-fail'
      ? result
      : {
          ok: false,
          rejection: 'key-mismatch',
          detail: `KEY_MISMATCH: verifier key '${receiptKeyId}' does not authenticate this receipt`,
        };
  }

  let lastMacFailure: ReturnType<typeof verifyGateReceipt> | null = null;
  for (const entry of keyring.keys) {
    const result = verifyGateReceipt(entry.key, candidate, expected);
    if (result.ok) return result;
    if (result.rejection === 'mac-fail') lastMacFailure = result;
    else return result;
  }
  return {
    ok: false,
    rejection: 'key-mismatch',
    detail: `KEY_MISMATCH: no trusted verifier key authenticates this receipt${lastMacFailure === null ? '' : ' (MAC check failed)'}`,
  };
}

/** Loads and validates an owner-only regular key-ring file without following links. */
export function readSecureKeyring(path: string): VerifierKeyringDocument {
  const fd = openSecureFile(path);
  let raw: string;
  try {
    const info = fstatSync(fd);
    assertSecureFileInfo(info, path);
    raw = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  return parseKeyringDocument(raw, path);
}

/** Creates an initial owner-only key ring at a new external path. */
export function createVerifierKeyringFile(path: string): { document: VerifierKeyringDocument; keyId: string } {
  const keyId = newKeyId();
  const document: VerifierKeyringDocument = {
    schemaVersion: 1,
    activeKeyId: keyId,
    keys: { [keyId]: randomBytes(32).toString('base64url') },
  };
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    throw new UsageError(`key create: cannot create verifier key file '${path}': ${(error as Error).message}`);
  }
  try {
    assertSecureFileInfo(fstatSync(fd), path);
    writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(path);
    throw error;
  }
  closeSync(fd);
  return { document, keyId };
}

/** Rotates the active key and retains every previous key for receipt verification. */
export function rotateVerifierKeyring(document: VerifierKeyringDocument): { document: VerifierKeyringDocument; keyId: string } {
  const keyId = newKeyId();
  return {
    document: { schemaVersion: 1, activeKeyId: keyId, keys: { ...document.keys, [keyId]: randomBytes(32).toString('base64url') } },
    keyId,
  };
}

/** Adds an environment key to a ring so existing receipts stay verifiable after source migration. */
export function importEnvironmentVerifierKey(
  document: VerifierKeyringDocument,
  key: string,
): { document: VerifierKeyringDocument; keyId: string } {
  if (key.length === 0) throw new UsageError(`key import-env: ${VERIFIER_KEY_ENV} is required`);
  const keyId = environmentVerifierKeyId(key);
  const existing = document.keys[keyId];
  if (existing !== undefined && existing !== key) {
    throw new UsageError(`key import-env: key id collision for '${keyId}'`);
  }
  return {
    document: { schemaVersion: 1, activeKeyId: document.activeKeyId, keys: { ...document.keys, [keyId]: key } },
    keyId,
  };
}

/** Removes a retained key after confirming it is not active. */
export function retireVerifierKey(document: VerifierKeyringDocument, keyId: string): VerifierKeyringDocument {
  if (keyId === document.activeKeyId) throw new UsageError('cannot retire the active verifier key; rotate first');
  if (document.keys[keyId] === undefined) throw new UsageError(`unknown verifier key id '${keyId}'`);
  const keys = { ...document.keys };
  delete keys[keyId];
  return { schemaVersion: 1, activeKeyId: document.activeKeyId, keys };
}

/** Atomically replaces an existing secure key ring. */
export function writeSecureKeyring(path: string, document: VerifierKeyringDocument): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    assertSecureFileInfo(fstatSync(fd), temporary);
    writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}

/** Converts a secret or existing ring argument to a ring. */
export function verifierKeyringFrom(
  source: string | VerifierKeyring | null,
): VerifierKeyring | null {
  if (source === null) return null;
  if (typeof source !== 'string') return source;
  const active = { keyId: environmentVerifierKeyId(source), key: source };
  return { active, keys: [active] };
}

/** Opens one regular key file without following a symbolic link.
 *
 * Args:
 *   path: absolute external key-file path.
 *
 * Returns:
 *   number: an open file descriptor.
 */
function openSecureFile(path: string): number {
  try {
    const linkInfo = lstatSync(path);
    if (linkInfo.isSymbolicLink()) throw new UsageError('verifier key file must not be a symbolic link');
    assertSecureFileInfo(linkInfo, path);
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      const info = lstatSync(path);
      const currentUid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
      throw new UsageError(
        `verifier key exists at '${path}' but is not readable by uid ${String(currentUid)} ` +
          `(owner uid ${String(info.uid)}) — rerun the suite as this user or fix ownership`,
      );
    }
    throw new UsageError(`cannot open verifier key file '${path}': ${(error as Error).message}`);
  }
}

/** Requires a current-user-owned file with no group access or other links.
 *
 * Args:
 *   info: filesystem metadata for the open file.
 *   path: key-file path used in diagnostics.
 */
function assertSecureFileInfo(info: { isFile(): boolean; mode: number; uid: number; nlink: number }, path: string): void {
  if (!info.isFile()) throw new UsageError(`verifier key file '${path}' must be a regular file`);
  if ((info.mode & 0o077) !== 0) {
    throw new UsageError(`verifier key file '${path}' must be owner-only (mode 0600 or stricter)`);
  }
  if (info.nlink !== 1) throw new UsageError(`verifier key file '${path}' must not have other hard links`);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && info.uid !== currentUid) {
    throw new UsageError(
      `verifier key exists at '${path}' but is not readable by uid ${String(currentUid)} ` +
        `(owner uid ${String(info.uid)}) — rerun the suite as this user or fix ownership`,
    );
  }
}

/** Parses the versioned key-ring JSON without exposing secret values in errors.
 *
 * Args:
 *   raw: key-ring file contents.
 *   path: source path used in diagnostics.
 *
 * Returns:
 *   VerifierKeyringDocument: validated ids and secret values.
 */
function parseKeyringDocument(raw: string, path: string): VerifierKeyringDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UsageError(`verifier key file '${path}' is not valid JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageError(`verifier key file '${path}' must contain a key-ring object`);
  }
  const document = value as Record<string, unknown>;
  if (
    document['schemaVersion'] !== 1 ||
    typeof document['activeKeyId'] !== 'string' ||
    !KEY_ID_PATTERN.test(document['activeKeyId']) ||
    typeof document['keys'] !== 'object' ||
    document['keys'] === null ||
    Array.isArray(document['keys'])
  ) {
    throw new UsageError(`verifier key file '${path}' has an invalid key-ring header`);
  }
  const keys: Record<string, string> = {};
  for (const [keyId, key] of Object.entries(document['keys'] as Record<string, unknown>)) {
    if (!KEY_ID_PATTERN.test(keyId) || typeof key !== 'string' || key.length === 0) {
      throw new UsageError(`verifier key file '${path}' has an invalid key entry`);
    }
    keys[keyId] = key;
  }
  if (Object.keys(keys).length === 0 || keys[document['activeKeyId']] === undefined) {
    throw new UsageError(`verifier key file '${path}' must include its active key`);
  }
  return { schemaVersion: 1, activeKeyId: document['activeKeyId'], keys };
}

/** Resolves existing symlinks and appends any not-yet-existing path suffix.
 *
 * Args:
 *   path: absolute or relative filesystem path.
 *
 * Returns:
 *   string: canonical absolute path when its existing parent can be read.
 */
function canonicalizePath(path: string): string {
  if (isAbsolute(path)) {
    let cursor = resolve(path);
    const suffix: string[] = [];
    while (true) {
      try {
        return resolve(realpathSync(cursor), ...suffix.reverse());
      } catch {
        const parent = dirname(cursor);
        if (parent === cursor) return resolve(path);
        suffix.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
        cursor = parent;
      }
    }
  }
  return canonicalizePath(resolve(path));
}

/** Returns whether one resolved path is the root or one of its descendants.
 *
 * Args:
 *   root: canonical protected root.
 *   path: canonical candidate path.
 *
 * Returns:
 *   boolean: true when `path` is within `root`.
 */
function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/** Creates an unrelated, non-secret id for one newly generated key.
 *
 * Returns:
 *   string: a unique key id.
 */
function newKeyId(): string {
  return `key-${randomBytes(12).toString('hex')}`;
}
