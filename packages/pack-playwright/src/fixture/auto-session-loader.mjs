import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
const wrapper = new URL('./auto-session-wrapper.mjs', import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  const testModule = specifier === '@playwright/test' || specifier === 'playwright/test';
  if (testModule && context.parentURL === wrapper) {
    // Playwright's loader may delegate to require.resolve: use a dependency
    // importer so the CJS redirect cannot turn this export-star into a cycle.
    return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(process.env.GATEFORGE_PLAYWRIGHT_CONFIG_DIR || process.cwd(), 'node_modules', '__gateforge__.mjs')).href });
  }
  if (testModule && context.parentURL?.startsWith('file:') &&
      context.parentURL !== wrapper &&
      !fileURLToPath(context.parentURL).replaceAll('\\', '/').includes('/node_modules/')) {
    return { url: wrapper, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
