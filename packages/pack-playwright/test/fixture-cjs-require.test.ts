/**
 * CommonJS-consumer regression tests (plan 0.9.2 finding E, item E1).
 *
 * Suite traffic reaches the supervisor's observation proxy ONLY when
 * `page` comes from Gateforge's fixture (`routePageThroughSessionProxy`,
 * fixture.ts). A suite that cannot load the fixture therefore sends every
 * request straight past the witness, and each `observed-e2e` transport
 * claim finalizes with "no HTTP exchange passed through this session's
 * observation proxy" — a passing test with missing claims, which is the
 * exact real-repo failure finding E describes.
 *
 * CommonJS is the shape most existing Playwright suites already have, so
 * the fix is that `require('@gate-forge/pack-playwright/fixture')` must
 * work. Two load paths are pinned because they fail differently:
 *
 * 1. a REAL Node CommonJS require of the published subpath (a spawned
 *    `node` process: the `exports` map, `require(esm)`, and the top-level
 *    await that used to forbid it — no test-runner transform between the
 *    require and the loader);
 * 2. the same require performed from a suite, with the routing helper
 *    arriving through `require` instead of `import` — the shape the
 *    guides document for a shared CommonJS fixture.
 *
 * `require(esm)` needs Node >= 20.19 / >= 22.12 (the same floor the
 * repo's own Vite toolchain requires); this suite runs on the current
 * interpreter and pins the mechanism, not one version string.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as PlaywrightTest from 'playwright/test';
import { ROOT } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);

/** The CommonJS consumer base: `require('@gate-forge/pack-playwright/fixture')`. */
const BASE_PATH = join(ROOT, 'packages/pack-playwright/test/fixture-cjs-base.cjs');

const APP_ORIGIN = 'http://localhost:3311';
const SESSION_ORIGIN = 'http://localhost:4411';

type RoutePage = (
  page: PlaywrightTest.Page,
  appBaseURL: string,
  sessionProxyURL: string,
) => Promise<void>;

/** What the CommonJS base hands back: the fixture entry's own exports. */
interface FixtureBase {
  test: typeof PlaywrightTest.test;
  expect: typeof PlaywrightTest.expect;
  routePageThroughSessionProxy: RoutePage;
}

// The one unchecked cast in this suite, at the boundary it describes: Node's
// CommonJS loader returns the require()'d module untyped, and its shape is
// the fixture entry's own exports.
const BASE = nodeRequire(BASE_PATH) as FixtureBase;

interface StubPage {
  page: PlaywrightTest.Page;
  /** How many route handlers the helper installed (a shared origin installs none). */
  readonly handlers: number;
  /** Drives the installed route handler once for `url`. */
  drive(url: string, resourceType?: string): Promise<void>;
  /** Each fallback call, including the forwarded URL and request headers. */
  readonly fallenBack: ReadonlyArray<{ url: string | undefined; headers: Record<string, string> | undefined }>;
}

/**
 * A Page stand-in recording what the route handler did. It models the
 * request fields the routing helper consumes, pinning both the rewrite and
 * the per-request resource-type header alongside preserved request headers.
 */
function stubPage(): StubPage {
  const handlers: Array<(route: PlaywrightTest.Route) => Promise<void>> = [];
  const fallenBack: Array<{ url: string | undefined; headers: Record<string, string> | undefined }> = [];
  return {
    page: {
      route(_pattern: string, handler: (route: PlaywrightTest.Route) => Promise<void>): void {
        handlers.push(handler);
      },
    } as unknown as PlaywrightTest.Page,
    get handlers(): number {
      return handlers.length;
    },
    fallenBack,
    async drive(url: string, resourceType = 'document'): Promise<void> {
      const handler = handlers[0];
      if (handler === undefined) throw new Error('no route handler was installed');
      await handler({
        request: () => ({
          url: () => url,
          resourceType: () => resourceType,
          headers: () => ({ 'x-existing': 'kept' }),
        }),
        fallback: async (options?: { url?: string; headers?: Record<string, string> }) => {
          fallenBack.push({ url: options?.url, headers: options?.headers });
        },
      } as unknown as PlaywrightTest.Route);
    },
  };
}

describe('CommonJS suites can build on the fixture (plan 0.9.2 E1)', () => {
  it('a real Node require of the fixture entry loads test/expect', () => {
    const probe = spawnSync(process.execPath, [BASE_PATH], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(probe.stderr).toBe('');
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toBe('test=function expect=function route=function');
  });

  it('the fixture subpath publishes a require condition beside import', () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'packages/pack-playwright/package.json'), 'utf8'),
    ) as { exports: Record<string, Record<string, string>> };
    expect(manifest.exports['./fixture']).toEqual({
      types: './dist/fixture/fixture.d.ts',
      require: './dist/fixture/fixture.js',
      import: './dist/fixture/fixture.js',
    });
  });

  it('a required fixture base exposes the runner and the routing helper', () => {
    expect(typeof BASE.test).toBe('function');
    expect(typeof BASE.expect).toBe('function');
    expect(typeof BASE.routePageThroughSessionProxy).toBe('function');
  });

  it('the required routing helper rewrites app traffic onto the session proxy', async () => {
    const stub = stubPage();
    await BASE.routePageThroughSessionProxy(stub.page, APP_ORIGIN, SESSION_ORIGIN);
    await stub.drive(`${APP_ORIGIN}/dashboard?tab=1`, 'document');
    await stub.drive('https://cdn.example.test/asset.js', 'script');
    expect(stub.handlers).toBe(1);
    expect(stub.fallenBack).toEqual([
      {
        url: `${SESSION_ORIGIN}/dashboard?tab=1`,
        headers: { 'x-existing': 'kept', 'x-gateforge-resource-type': 'document' },
      },
      { url: undefined, headers: undefined },
    ]);
  });

  it('the required routing helper refuses a proxy that is not the app host', async () => {
    const stub = stubPage();
    await expect(
      BASE.routePageThroughSessionProxy(stub.page, APP_ORIGIN, 'https://elsewhere.test:4411'),
    ).rejects.toThrow('must share the same loopback HTTP host');
    expect(stub.handlers).toBe(0);
  });

  it('the required routing helper stays out of the way for a shared origin', async () => {
    const stub = stubPage();
    await BASE.routePageThroughSessionProxy(stub.page, APP_ORIGIN, APP_ORIGIN);
    expect(stub.handlers).toBe(0);
  });
});