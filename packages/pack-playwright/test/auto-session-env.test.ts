import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { autoSessionNodeOptions } from '../src/fixture/auto-session-env.js';
import { supervisedRunnerChildEnv } from '../src/discovery/supervised-run.js';

const hook = fileURLToPath(new URL('../dist/fixture/auto-session.cjs', import.meta.url));
describe('witnessed Playwright preload environment', () => {
  it('quotes the shipped hook and preserves existing options', () => {
    expect(autoSessionNodeOptions('--max-old-space-size=512')).toBe(`--max-old-space-size=512 --require ${JSON.stringify(hook)}`);
  });
  it('adds the hook only to witnessed children', () => {
    expect(supervisedRunnerChildEnv({}, process.cwd(), {})['NODE_OPTIONS']).toBeUndefined();
    expect(supervisedRunnerChildEnv({ GATEFORGE_WITNESS_URL: 'http://127.0.0.1:1' }, process.cwd(), {})['NODE_OPTIONS']).toBe(`--require ${JSON.stringify(hook)}`);
  });
  it('retains supervisor-supplied options without admitting ambient loader controls', () => {
    const child = supervisedRunnerChildEnv({ GATEFORGE_WITNESS_URL: 'http://127.0.0.1:1', NODE_OPTIONS: '--max-old-space-size=512' }, process.cwd(), { NODE_OPTIONS: '--require unwanted.cjs' });
    expect(child['NODE_OPTIONS']).toBe(`--max-old-space-size=512 --require ${JSON.stringify(hook)}`);
  });
  it('forwards root properties without changing either the fixture or the real runner', () => {
    const forwardRoot = createRequire(import.meta.url)('../src/fixture/auto-session-root.cjs');
    const root = { test: {}, request: {}, chromium: { name: 'original' }, defineConfig: () => 'config' };
    const fixture = new Proxy({ extend: () => 'tracked extension' }, {});
    const request = { newContext: () => 'direct context' };
    const fixtureKeys = Reflect.ownKeys(fixture);
    const forwarded = forwardRoot(root, fixture, request);
    expect(forwarded).not.toBe(fixture);
    expect(forwarded.test).toBe(forwarded);
    expect(forwarded.request).toBe(request);
    expect(forwarded.extend()).toBe('tracked extension');
    expect(forwarded.defineConfig).toBe(root.defineConfig);
    root.chromium = { name: 'updated' };
    expect(forwarded.chromium).toBe(root.chromium);
    expect(root.test).not.toBe(fixture);
    expect(root.request).not.toBe(request);
    expect(Reflect.ownKeys(fixture)).toEqual(fixtureKeys);
    expect('test' in fixture).toBe(false);
    expect('request' in fixture).toBe(false);
    expect('chromium' in fixture).toBe(false);
    expect('request' in forwarded).toBe(true);
    expect('chromium' in forwarded).toBe(true);
  });
});
