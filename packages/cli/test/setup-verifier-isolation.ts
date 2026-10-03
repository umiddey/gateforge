/**
 * Verifier-keyring isolation for the cli test suite (0.9.0).
 *
 * `resolveVerifierKeyring` falls back to the owner-managed DEFAULT key ring
 * at `$XDG_CONFIG_HOME|$HOME/.config/gateforge/verifier-keyring.json`
 * whenever `GATEFORGE_WITNESS_VERIFIER_KEY` is absent
 * (`defaultVerifierKeyringPath` in `src/verifier-keys.ts`). A developer
 * machine that ever ran `gateforge key create` therefore leaks its REAL key
 * into the suite: a test that must fail closed for "no verifier key is
 * provisioned" instead travels far past that refusal and dies later with an
 * unrelated message — two tests were machine-dependent exactly that way
 * (a policy-pin gate test and the attestation matrix's "key absent or wrong
 * authorizes nothing" row).
 *
 * This setup file runs in every worker BEFORE any test file in this package:
 * it points `XDG_CONFIG_HOME` at a fresh empty temp directory, so the default
 * key file cannot exist, and it clears both verifier-key sources from
 * `process.env`.
 *
 * Deliberately untouched:
 *
 * - `HOME` — Python toolchains, Playwright browsers and the pre-commit cache
 *   live under it;
 * - `XDG_CACHE_HOME` / `XDG_DATA_HOME`;
 * - everything else in the environment.
 *
 * A test that needs a key still provisions it EXPLICITLY and locally (an env
 * key, a `key create --file <path>` ring, or its own `XDG_CONFIG_HOME`), and
 * that per-call env always wins over this worker-level default.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['XDG_CONFIG_HOME'] = mkdtempSync(join(tmpdir(), 'gateforge-cli-test-xdg-'));
delete process.env['GATEFORGE_WITNESS_VERIFIER_KEY'];
delete process.env['GATEFORGE_WITNESS_VERIFIER_KEY_FILE'];