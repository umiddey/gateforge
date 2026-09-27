import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isNormalizedRepoRelativePath, sha256Canonical } from '@gate-forge/core';

/** One owner-approved link from a candidate path to a dependency root. */
export interface RuntimeReuseMount {
  /** Candidate-relative path declared in the trusted runtime document. */
  path: string;
  /** Candidate checkout that contains the link. */
  checkoutRoot: string;
  /** User-repository root that approves the dependency source. */
  ownerRoot: string;
  /** Resolved dependency root reached through the owner-approved path. */
  sourceRoot: string;
}

/** Error raised when a declared reuse boundary is not the link we approved. */
export class RuntimeReuseBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeReuseBoundaryError';
  }
}

/** Validates that each supplied mount still matches its approved link. */
export function validateRuntimeReuseMounts(workspace: string, mounts: readonly RuntimeReuseMount[]): void {
  for (const mount of mounts) {
    const checkoutRoot = resolve(mount.checkoutRoot);
    let ownerRoot: string;
    let sourceRoot: string;
    let expectedSourceRoot: string;
    try {
      ownerRoot = realpathSync(resolve(mount.ownerRoot));
      sourceRoot = realpathSync(resolve(mount.sourceRoot));
      if (!isNormalizedRepoRelativePath(mount.path)) {
        throw new RuntimeReuseBoundaryError(`runtime reuse mount '${mount.path}' is not a normalized repository path`);
      }
      expectedSourceRoot = realpathSync(resolve(ownerRoot, ...mount.path.split('/')));
    } catch {
      throw new RuntimeReuseBoundaryError(`runtime reuse mount '${mount.path}' has an unavailable approved root`);
    }
    const checkoutPath = resolve(workspace, ...mount.path.split('/'));
    const expectedCheckoutPath = resolve(checkoutRoot, ...mount.path.split('/'));
    if (checkoutRoot !== resolve(workspace) || checkoutPath !== expectedCheckoutPath) {
      throw new RuntimeReuseBoundaryError(`runtime reuse mount '${mount.path}' does not belong to this candidate`);
    }
    if (sourceRoot !== expectedSourceRoot || sourceRoot === ownerRoot) {
      throw new RuntimeReuseBoundaryError(`runtime reuse mount '${mount.path}' no longer matches its approved source`);
    }
    let target: string;
    try {
      if (!lstatSync(checkoutPath).isSymbolicLink()) {
        throw new RuntimeReuseBoundaryError(`runtime reuse mount '${mount.path}' is no longer a symbolic link`);
      }
      target = realpathSync(checkoutPath);
    } catch (error) {
      if (error instanceof RuntimeReuseBoundaryError) throw error;
      throw new RuntimeReuseBoundaryError(`runtime reuse mount '${mount.path}' is broken or unavailable`);
    }
    if (target !== sourceRoot) {
      throw new RuntimeReuseBoundaryError(`runtime reuse mount '${mount.path}' no longer points to its approved source`);
    }
  }
}

/** Adds stable byte and type records for one approved dependency tree. */
function collectEntries(
  absolute: string,
  logicalPath: string,
  active: Set<string>,
  entries: Array<Record<string, string | number>>,
): void {
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw new RuntimeReuseBoundaryError(`runtime reuse entry '${logicalPath}' is missing or unreadable`);
  }
  if (stat.isSymbolicLink()) {
    let target: string;
    let resolvedTarget: string;
    try {
      target = readlinkSync(absolute);
      resolvedTarget = realpathSync(absolute);
    } catch {
      throw new RuntimeReuseBoundaryError(`runtime reuse link '${logicalPath}' is broken or unreadable`);
    }
    const stableTarget = isAbsolute(target)
      ? `absolute:${createHash('sha256').update(target, 'utf8').digest('hex')}`
      : `relative:${target.split('\\').join('/')}`;
    entries.push({ path: logicalPath, type: 'symlink', target: stableTarget });
    if (active.has(resolvedTarget)) {
      entries.push({ path: `${logicalPath}=>cycle`, type: 'cycle' });
      return;
    }
    collectEntries(
      resolvedTarget,
      `${logicalPath}=>${stableTarget}`,
      new Set([...active, resolvedTarget]),
      entries,
    );
    return;
  }
  let resolved: string;
  try {
    resolved = realpathSync(absolute);
  } catch {
    throw new RuntimeReuseBoundaryError(`runtime reuse entry '${logicalPath}' is unavailable`);
  }
  if (active.has(resolved)) {
    entries.push({ path: logicalPath, type: 'cycle' });
    return;
  }
  if (stat.isDirectory()) {
    entries.push({ path: logicalPath, type: 'directory', mode: stat.mode & 0o777 });
    let children: string[];
    try {
      children = readdirSync(absolute).sort();
    } catch {
      throw new RuntimeReuseBoundaryError(`runtime reuse directory '${logicalPath}' is unreadable`);
    }
    for (const child of children) {
      collectEntries(join(absolute, child), `${logicalPath}/${child}`, new Set([...active, resolved]), entries);
    }
    return;
  }
  if (!stat.isFile()) {
    throw new RuntimeReuseBoundaryError(`runtime reuse entry '${logicalPath}' is a special file`);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch {
    throw new RuntimeReuseBoundaryError(`runtime reuse file '${logicalPath}' is unreadable`);
  }
  entries.push({
    path: logicalPath,
    type: 'file',
    mode: stat.mode & 0o777,
    digest: createHash('sha256').update(bytes).digest('hex'),
  });
}

/** Hashes the exact reachable bytes beneath the supplied approved mounts. */
export function digestRuntimeReuseMounts(mounts: readonly RuntimeReuseMount[]): string | null {
  if (mounts.length === 0) return null;
  validateRuntimeReuseMounts(mounts[0]?.checkoutRoot ?? '', mounts);
  const entries: Array<Record<string, string | number>> = [];
  for (const mount of [...mounts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const root = realpathSync(resolve(mount.sourceRoot));
    entries.push({ path: mount.path, type: 'mount' });
    collectEntries(root, mount.path, new Set(), entries);
  }
  return sha256Canonical({ domain: 'gateforge.runtime-reuse.v2', entries });
}

/** Hashes configured dependency roots for the legacy diagnostic helper. */
export function digestRuntimeReuseSources(ownerRootPath: string, paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const ownerRoot = realpathSync(resolve(ownerRootPath));
  const entries: Array<Record<string, string | number>> = [];
  for (const path of [...paths].sort()) {
    const source = resolve(ownerRoot, ...path.split('/'));
    let sourceRoot: string;
    try {
      sourceRoot = realpathSync(source);
    } catch {
      entries.push({ path, type: 'source-absent' });
      continue;
    }
    if (!isNormalizedRepoRelativePath(path) || sourceRoot === ownerRoot) {
      throw new RuntimeReuseBoundaryError(`runtime reuse source '${path}' is not a valid approved dependency root`);
    }
    entries.push({ path, type: 'mount' });
    collectEntries(sourceRoot, path, new Set(), entries);
  }
  return sha256Canonical({ domain: 'gateforge.runtime-reuse.v2', entries });
}

/** Returns the candidate-relative paths covered by approved reuse mounts. */
export function isRuntimeReusePath(path: string, mounts: readonly RuntimeReuseMount[]): boolean {
  return mounts.some((mount) => path === mount.path || path.startsWith(`${mount.path}/`));
}
