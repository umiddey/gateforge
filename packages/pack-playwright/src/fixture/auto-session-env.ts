import { fileURLToPath } from 'node:url';

/** Append the engine preload only to a witnessed Playwright child's environment. */
export function autoSessionNodeOptions(existing: string | undefined): string {
  const hook = fileURLToPath(new URL('../../dist/fixture/auto-session.cjs', import.meta.url));
  return [existing, `--require ${JSON.stringify(hook)}`].filter(Boolean).join(' ');
}
