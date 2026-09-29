/**
 * In-process Git object id computation and loose-object writing.
 *
 * Why: candidate-tree ingestion used to spawn one `git hash-object` per
 * file and one `git mktree` per directory level. On a consumer checkout
 * (~67k files) that is hundreds of process spawns per computation and
 * minutes of wall clock for work that is a SHA-1 and a zlib stream.
 * This module produces the identical object ids and the identical
 * on-disk loose objects without spawning anything: Git's object format
 * is a documented byte layout, so the same bytes in, the same id out.
 *
 * The objects it writes are ordinary loose objects in the same object
 * directory `git hash-object -w --git-dir=<dir>` would have written to,
 * so every downstream `git cat-file`/`git diff-tree` on the candidate
 * tree keeps working unchanged.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

/** Git object kinds this module writes. */
export type GitObjectType = 'blob' | 'tree';

/** Git's mode string for a subtree entry (`git mktree` accepts `040000`, git stores `40000`). */
const TREE_MODE = '40000';

/** Git's mode string for an entry parsed as a subtree. */
const TREE_MODE_PADDED = '040000';

/**
 * Computes the Git object id of `payload` without touching the object store.
 *
 * Args:
 *   type: object kind written into the id header (`blob` or `tree`).
 *   payload: raw object content (the bytes a `git cat-file -p` would show).
 *
 * Returns:
 *   string: 40-char lowercase sha1 hex, byte-identical to `git hash-object`.
 */
export function hashGitObject(type: GitObjectType, payload: Buffer): string {
  const header = Buffer.from(`${type} ${payload.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(payload).digest('hex');
}

/**
 * Serializes one tree object payload exactly as Git stores it:
 * `<mode> <name>\0<20 raw id bytes>` per entry, already in Git's tree
 * order (see {@link sortTreeEntries}).
 *
 * Args:
 *   entries: tree entries with a Git mode, a directory name, and the
 *     40-hex object id of the entry.
 *
 * Returns:
 *   Buffer: the raw tree payload (no header).
 */
export function serializeTreePayload(entries: readonly { mode: string; name: string; sha: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode === TREE_MODE_PADDED ? TREE_MODE : entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/**
 * Compares two tree entries the way Git does: by name bytes, with a
 * directory name compared as if it ended in `/`. That is why the blob
 * `a!` sorts before the directory `a` (`!` < `/`) even though a plain
 * name sort puts them the other way round.
 *
 * Args:
 *   a: first entry (its mode decides whether the name gets a `/`).
 *   b: second entry.
 *
 * Returns:
 *   number: negative, zero, or positive like a comparator.
 */
export function compareTreeEntries(a: { mode: string; name: string }, b: { mode: string; name: string }): number {
  const left = Buffer.from(a.mode === TREE_MODE_PADDED ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === TREE_MODE_PADDED ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/**
 * Sorts tree entries into Git's canonical tree order.
 *
 * Args:
 *   entries: tree entries with a Git mode and a directory name.
 *
 * Returns:
 *   T[]: the same entries in Git's tree order.
 */
export function sortTreeEntries<T extends { mode: string; name: string }>(entries: readonly T[]): T[] {
  return [...entries].sort(compareTreeEntries);
}

/**
 * Writes loose objects into one object directory, skipping ids that are
 * already present. Every write is atomic (temp file + rename) and
 * content-addressed, so a repeated write of the same id is a no-op.
 */
export class LooseObjectWriter {
  private readonly objectsDir: string;

  /** Ids this writer already wrote (per process, never persisted). */
  private readonly written = new Set<string>();

  /**
   * Args:
   *   objectsDir: absolute path of the repository's `objects` directory.
   */
  constructor(objectsDir: string) {
    this.objectsDir = objectsDir;
  }

  /**
   * Hashes `payload` and stores it as a loose object.
   *
   * Args:
   *   type: object kind (`blob` or `tree`).
   *   payload: raw object content.
   *
   * Returns:
   *   string: the 40-hex object id.
   */
  write(type: GitObjectType, payload: Buffer): string {
    const id = hashGitObject(type, payload);
    if (this.written.has(id)) return id;
    const fanout = join(this.objectsDir, id.slice(0, 2));
    const target = join(fanout, id.slice(2));
    if (existsSync(target)) {
      this.written.add(id);
      return id;
    }
    // Loose object files hold `<type> <size>\0<payload>`; the id itself
    // is the file name and never part of the stored bytes.
    const framed = Buffer.concat([Buffer.from(`${type} ${payload.length}\0`, 'utf8'), payload]);
    // Level 1 is Git's default loose-object compression
    // (core.loosecompression); the level never changes the object id,
    // only the stored bytes.
    const compressed = deflateSync(framed, { level: 1 });
    const temp = join(this.objectsDir, `tmp_obj_${process.pid}_${randomBytes(8).toString('hex')}`);
    try {
      mkdirSync(fanout, { recursive: true, mode: 0o777 });
      writeFileSync(temp, compressed);
      chmodSync(temp, 0o444);
      renameSync(temp, target);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // The temp file is already gone; the original error is the useful one.
      }
      throw error;
    }
    this.written.add(id);
    return id;
  }
}
