/**
 * A `FASTAPI_PREFIX_UNRESOLVED` block is answerable from the output alone.
 *
 * Reproduced on the canonical FastAPI full-stack template: after every
 * route question is answered, the terminal block of the whole `next` loop
 * was
 *
 *   next: repo
 *   cause: BLOCKING_FINDING
 *   why: FASTAPI_PREFIX_UNRESOLVED: include_router prefix in
 *        backend/app/main.py is computed; the effective path cannot be
 *        proven statically
 *   do: gateforge discover --json
 *
 * The detector is right — `app.include_router(api_router,
 * prefix=settings.API_V1_STR)` cannot be read statically, and guessing a
 * path would fabricate routes the app does not serve. The `do:` is the
 * defect: `discover --json` is read-only, so the documented agent loop (run
 * the printed command, run `next` again) printed the identical block
 * forever, and unlike `ENDPOINT_SEMANTICS_UNRESOLVED` the cause got no
 * guidance block at all.
 *
 * Only mechanisms that EXIST today may be printed, and each was verified
 * by running it against the real in-process pack before this block was
 * written:
 *   - make the prefix a LITERAL at the mount site: the same app with
 *     `prefix="/api/v1"` yields its routes and the finding disappears
 *     (also pinned by the pack's own real-detector test,
 *     `pack-fastapi/test/subprocess.test.ts`);
 *   - a capability rule in `.gateforge/endpoints.json` CANNOT match — the
 *     detector emits no route fact at all for a computed prefix, so there
 *     is no method/path to key a rule on;
 *   - `gateforge waive` CANNOT reach it — the finding resolves no
 *     obligation (`waive: no obligation resolves for …`, exit 2);
 *   - `.gateforge/fastapi.json`'s `importRoots` does NOT apply — it
 *     governs absolute imports; with it configured the same finding stands.
 *
 * So the block names the literal-prefix fix and nothing else, and the
 * missing declaration key is reported to the pack owner rather than
 * invented here.
 *
 * `--json` gains the additive `fastapiPrefixGuidance` key, absent for
 * every other finding; existing keys keep their values.
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { PLUGIN_SOURCE, installFixture, runCli } from './helpers.js';
/** The template's own finding, as `pack-fastapi` emits it. */
const PREFIX_UNRESOLVED = {
  code: 'FASTAPI_PREFIX_UNRESOLVED',
  detail:
    'include_router prefix in backend/app/main.py is computed; the effective path ' +
    'cannot be proven statically',
  location: { file: 'backend/app/main.py', line: 35, col: 0 },
};


const COMPUTED_PREFIX_PLUGIN_SOURCE = PLUGIN_SOURCE.replace(
  'return { resources, unresolved: [], findings: [], classificationSignals, scannedPaths };',
  `return {
         resources,
         unresolved: [${JSON.stringify(PREFIX_UNRESOLVED)}],
         findings: [],
         classificationSignals,
         scannedPaths,
       };`,
);

/** Installs the fixture project whose ONE open block is the computed prefix. */
function withComputedPrefix(repo: Parameters<typeof installFixture>[0]): void {
  installFixture(repo);
  repo.writeFiles({ 'plugin.mjs': COMPUTED_PREFIX_PLUGIN_SOURCE });
}

describe('gateforge next: a computed FastAPI router prefix is answerable', () => {
  it('names the one mechanism that closes it and never the read-only dump', async () => {
    await withTempRepo({}, async (repo) => {
      withComputedPrefix(repo);
      const { code, stdout } = await runCli(repo, ['next']);
      expect(code).toBe(1);
      expect(stdout).toContain('FASTAPI_PREFIX_UNRESOLVED');
      expect(stdout).toContain('backend/app/main.py');
      // The read-only dump that looped forever is gone; the printed
      // action changes state and says why the block exists.
      expect(stdout).not.toContain('do: gateforge discover --json');
      expect(stdout).toContain('about this block:');
      expect(stdout).toContain('literal');
      expect(stdout).toContain('backend/app/main.py');
      // Nothing that does not work for THIS finding.
      expect(stdout).not.toContain('endpoints.json');
      expect(stdout).not.toContain('importRoots');
      expect(stdout).not.toContain('gateforge waive');
    });
  });

  it('--json carries the guidance additively and only for this cause', async () => {
    await withTempRepo({}, async (repo) => {
      withComputedPrefix(repo);
      const { stdout } = await runCli(repo, ['next', '--json']);
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(Array.isArray(parsed['fastapiPrefixGuidance'])).toBe(true);
      expect((parsed['fastapiPrefixGuidance'] as string[]).join('\n')).toContain(
        'backend/app/main.py',
      );
      // Existing keys keep their values.
      expect(parsed['cause']).toBe('BLOCKING_FINDING');
      expect(String(parsed['why'])).toContain('FASTAPI_PREFIX_UNRESOLVED');

      // A repository with no such finding prints nothing new.
      await withTempRepo({}, async (other) => {
        installFixture(other);
        const clean = JSON.parse((await runCli(other, ['next', '--json'])).stdout) as Record<
          string,
          unknown
        >;
        expect(clean['fastapiPrefixGuidance']).toBeUndefined();
        const text = await runCli(other, ['next']);
        expect(text.stdout).not.toContain('about this block: the prefix');
      });
    });
  });
});
