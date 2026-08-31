/**
 * Cross-language suite: the TS host drives the Python reference detector
 * (stdlib-only client, ~GPP/1 _lib.py lineage). A green session here is
 * the proof that both implementations agree on framing, canonical-JSON
 * digests, handshake pinning, and the discovery payload shape.
 */
import { describe, expect, test } from 'vitest';
import { PluginError, PluginSession, isProtocolFailure } from '../src/index.js';
import {
  EXPECTED_FINDINGS,
  EXPECTED_RESOURCES,
  jsPluginOptions,
  pythonPluginOptions,
} from './helpers.js';

describe('TS host x Python plugin', () => {
  test('green session: handshake, two sequential discovers, clean shutdown', async () => {
    const session = new PluginSession(pythonPluginOptions());
    try {
      await session.start();
      const first = await session.discover(['app/routes.gfx']);
      expect(first.resources).toEqual(EXPECTED_RESOURCES);
      expect(first.unresolved).toEqual([]);
      expect(first.findings).toEqual(EXPECTED_FINDINGS);
      const second = await session.discover(['app/routes.gfx']);
      expect(second).toEqual(first);
      await session.shutdown();
    } finally {
      await session.dispose();
    }
  }, 20_000);

  test('both reference detectors emit byte-identical outcomes for the same fixture', async () => {
    const runJs = async (): Promise<string> => {
      const session = new PluginSession(jsPluginOptions('plugin_ok.mjs'));
      try {
        await session.start();
        return JSON.stringify(await session.discover(['app/routes.gfx']));
      } finally {
        await session.dispose();
      }
    };
    const runPy = async (): Promise<string> => {
      const session = new PluginSession(pythonPluginOptions());
      try {
        await session.start();
        return JSON.stringify(await session.discover(['app/routes.gfx']));
      } finally {
        await session.dispose();
      }
    };
    expect(await runJs()).toBe(await runPy());
  }, 20_000);

  test('a missing fixture path surfaces as E_PLUGIN_ERROR with the OSError detail', async () => {
    const session = new PluginSession(pythonPluginOptions());
    try {
      await session.start();
      await expect(session.discover(['missing.gfx'])).rejects.toSatisfy((error: unknown) => {
        if (!isProtocolFailure(error, 'E_PLUGIN_ERROR')) return false;
        expect(error.message).toContain('E_PLUGIN_INTERNAL');
        expect(error.message).toContain('No such file or directory');
        return true;
      });
    } finally {
      await session.dispose();
    }
  }, 20_000);
});
