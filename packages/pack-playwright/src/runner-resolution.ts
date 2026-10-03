import { dirname, join, resolve } from 'node:path';

/** Nearest install first; at each directory, @playwright/test before playwright. */
export function localPlaywrightCliCandidates(cwd: string): string[] {
  const candidates: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    candidates.push(join(dir, 'node_modules', '@playwright', 'test', 'cli.js'));
    candidates.push(join(dir, 'node_modules', 'playwright', 'cli.js'));
    const parent = dirname(dir);
    if (parent === dir) break;
  }
  return candidates;
}
