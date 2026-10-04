#!/usr/bin/env node
/**
 * Copies the repository CHANGELOG into `@gate-forge/cli` at PACK time.
 *
 * npm always ships README, LICENSE and package.json, but NOT the
 * changelog: a `files` whitelist can only name files inside the package,
 * so the release notes a user reads on npm are the monorepo root's file —
 * which no consumer of the tarball receives. 0.10.0 shipped with LICENSE,
 * README, bin, dist and guides and no release notes at all.
 *
 * This runs from `prepack` (both `npm pack` and `npm publish`), so the
 * tracked source of truth stays the single root CHANGELOG.md and the copy
 * is a build artifact: it is gitignored, never edited, and regenerated
 * from the root file on every pack. Fail closed rather than pack a tarball
 * whose release notes are missing.
 */
import { copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repoRoot, 'CHANGELOG.md');
const target = join(repoRoot, 'packages', 'cli', 'CHANGELOG.md');

try {
  statSync(source);
} catch {
  console.error(`copy-changelog: ${source} is missing — refusing to pack a tarball without release notes`);
  process.exit(1);
}

copyFileSync(source, target);
// stderr, never stdout: `scripts/release-publish.sh` parses the output of
// `npm pack --dry-run --json --workspaces` as pure JSON, and npm forwards
// a lifecycle script's stdout into that stream.
console.error(`copy-changelog: wrote packages/cli/CHANGELOG.md from the repository CHANGELOG.md`);