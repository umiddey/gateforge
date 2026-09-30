/**
 * Witness process entry (`gateforge-witness`): derives configuration
 * from CLI flags and the environment and starts the loopback witness
 * service.
 *
 * Usage (every flag has an env fallback; the flag wins when both are
 * given):
 *
 *   gateforge-witness [--help]
 *     [--proxy-target <url>]       start the observation proxy against
 *                                  this loopback base URL (ADR 0004 D7)
 *     [--mount-path <prefix>]      browser-facing mount prefix the proxy
 *                                  strips before forwarding AND recording
 *                                  (e.g. /api; requires --proxy-target)
 *     [--state-dir <dir>]          manifest append at shutdown
 *     [--classifications <path>]   classifications YAML input
 *     [--adapters-dir <dir>]       reviewed adapters (default .gateforge/adapters)
 *     [--target-base-url <url>]    attestation subject (GF-10, loopback)
 *     [--target-fingerprint <m>]   expected marker (GF-13)
 *     [--adapter-base-url <url>]   default adapter read base
 *
 * Env surface:
 *   GATEFORGE_RUN_ID, GATEFORGE_RUN_TOKEN        (required; CLI contract)
 *   GATEFORGE_PROXY_TARGET, GATEFORGE_MOUNT_PATH (observation proxy)
 *   GATEFORGE_STATE_DIR                          (manifest append at shutdown)
 *   GATEFORGE_ADAPTERS_DIR                       (default .gateforge/adapters)
 *   GATEFORGE_CLASSIFICATIONS                    (classifications YAML path)
 *   GATEFORGE_TARGET_BASE_URL                    (attestation subject, GF-10)
 *   GATEFORGE_TARGET_FINGERPRINT                 (expected marker, GF-13)
 *   GATEFORGE_ADAPTER_BASE_URL                   (default adapter read base)
 *   GATEFORGE_FIXTURE_PROVIDER                 (approved fixture provider)
 *   GATEFORGE_WITNESS_VERIFIER_KEY               (attestation verifier key)
 *
 * SECRETS NEVER TRAVEL ON ARGV (a process's cmdline is world-readable
 * via /proc — the same rule `gateforge test-gates` applies): the run
 * id/token are env-only (set by 'gateforge test-gates'), and the
 * verifier key is read from GATEFORGE_WITNESS_VERIFIER_KEY only. With a
 * verifier key the witness serves the MAC-attested ledger surface;
 * without one it stays unauthenticated and downstream evaluation fails
 * closed.
 *
 * The wrapper prints `GATEFORGE_WITNESS_URL=<url>` once listening — and
 * `GATEFORGE_WITNESS_PROXY_URL=<url>` when an observation proxy is
 * active; the process serves until SIGTERM/SIGINT.
 */
import { startWitness, WitnessStartupError } from './server.js';
import { loadFixtureProvider } from './fixture-provider.js';
import { parseChaosOptions } from './chaos.js';
import { parseTwinShapePlan, type TwinShapePlan } from './twin-shapes.js';
import {
  ENV_ADAPTER_BASE_URL,
  ENV_ADAPTERS_DIR,
  ENV_CHAOS_MAX_DELAY_MS,
  ENV_CHAOS_REORDER,
  ENV_CHAOS_SEED,
  ENV_CLASSIFICATIONS,
  ENV_FIXTURE_PROVIDER,
  ENV_MOUNT_PATH,
  ENV_PROXY_TARGET,
  ENV_RUN_ID,
  ENV_RUN_TOKEN,
  ENV_STATE_DIR,
  ENV_TARGET_BASE_URL,
  ENV_TARGET_FINGERPRINT,
  ENV_TWIN_INVENTORY,
  ENV_TWIN_OBSERVATION_ONLY,
  ENV_TWIN_QUERY_KEYS,
  ENV_TWIN_SHAPES,
  ENV_WITNESS_VERIFIER_KEY,
} from '../constants.js';
import type { WitnessHandle } from './types.js';
import type { EngineBrowserLauncher } from './browser.js';
import { createRequire } from 'node:module';

/** One-line usage (the header comment above is the long form). */
export const WITNESS_BIN_USAGE =
  'usage: gateforge-witness [--proxy-target <url>] [--mount-path <prefix>] ' +
  '[--state-dir <dir>] [--classifications <path>] [--adapters-dir <dir>] ' +
  '[--target-base-url <url>] [--target-fingerprint <marker>] [--adapter-base-url <url>] ' +
  '(run id/token via GATEFORGE_RUN_ID/GATEFORGE_RUN_TOKEN; verifier key via ' +
  'GATEFORGE_WITNESS_VERIFIER_KEY)';

/** Flags this bin accepts (values; `--help` is handled separately). */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  'proxy-target',
  'mount-path',
  'state-dir',
  'classifications',
  'adapters-dir',
  'target-base-url',
  'target-fingerprint',
  'adapter-base-url',
  'adapter-read-authorization',
]);

interface WitnessBinFlags {
  values: Map<string, string>;
}

/**
 * Parses the bin argv (`--flag value` and `--flag=value` shapes).
 * Unknown flags and missing values fail closed with the usage line —
 * a mis-wired harness must never silently start a half-configured
 * witness.
 *
 * Args:
 *   argv: arguments after node/script.
 *
 * Returns:
 *   WitnessBinFlags: parsed flag values.
 *
 * Throws:
 *   WitnessStartupError: on any malformed argv.
 */
function parseFlags(argv: readonly string[]): WitnessBinFlags {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) {
      throw new WitnessStartupError(`unexpected argument '${token}'\n${WITNESS_BIN_USAGE}`);
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    if (name.length === 0) {
      throw new WitnessStartupError(`invalid flag '${token}'\n${WITNESS_BIN_USAGE}`);
    }
    if (name === 'help') {
      continue; // handled by the caller before parsing matters
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new WitnessStartupError(`unknown flag '--${name}'\n${WITNESS_BIN_USAGE}`);
    }
    let value: string | undefined = eq >= 0 ? body.slice(eq + 1) : undefined;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new WitnessStartupError(`flag '--${name}' requires a value\n${WITNESS_BIN_USAGE}`);
      }
      value = next;
      index += 1;
    }
    if (values.has(name)) {
      throw new WitnessStartupError(`flag '--${name}' may only be given once\n${WITNESS_BIN_USAGE}`);
    }
    values.set(name, value);
  }
  return { values };
}

/** Flag value or its env fallback (undefined when neither is set). */
function flagOrEnv(
  flags: WitnessBinFlags,
  name: string,
  envValue: string | undefined,
): string | undefined {
  const fromFlags = flags.values.get(name);
  if (fromFlags !== undefined && fromFlags !== '') return fromFlags;
  if (envValue !== undefined && envValue !== '') return envValue;
  return undefined;
}

/**
 * The twin shape plan, or a fail-closed startup error.
 *
 * A malformed switch or an empty allowlist entry is the owner's
 * configuration speaking nonsense; starting anyway would produce a
 * run whose findings quietly mean something else.
 */
function parseTwinShapePlanOrFail(input: {
  shapes: string | undefined;
  queryKeys: string | undefined;
  inventoryPath: string | undefined;
}): TwinShapePlan | null {
  try {
    return parseTwinShapePlan(input);
  } catch (error) {
    throw new WitnessStartupError((error as Error).message);
  }
}

/**
 * The runner test ids the supervisor marked observation-only.
 *
 * Split from the engine's own comma-separated value and trimmed, so a
 * mark can never carry whitespace into an identity. An absent value is
 * the honest "no raw twin in this run".
 */
function observationOnlyTestIdsFrom(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * Reads env + argv and starts the witness.
 *
 * Args:
 *   argv: CLI flags (see the module header; `--help` prints usage and
 *     returns a never-started handle).
 *   env: process environment.
 *
 * Returns:
 *   WitnessHandle once listening (or a handle with an empty `url` for
 *   `--help`; the wrapper skips its URL banner in that case).
 *
 * Throws:
 *   WitnessStartupError / AttestationError / AdapterRegistryError:
 *     fail-closed startup problems (exit 2 via the wrapper).
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<WitnessHandle> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${WITNESS_BIN_USAGE}\n`);
    return Object.freeze({ url: '', proxyUrl: null, stop: async (): Promise<void> => {} });
  }
  const flags = parseFlags(argv);
  const runId = env[ENV_RUN_ID];
  const token = env[ENV_RUN_TOKEN];
  if (runId === undefined || runId === '') {
    throw new WitnessStartupError(`${ENV_RUN_ID} is required (set by 'gateforge test-gates')`);
  }
  if (token === undefined || token === '') {
    throw new WitnessStartupError(`${ENV_RUN_TOKEN} is required (set by 'gateforge test-gates')`);
  }
  // Environment-only, deliberately absent from argv (world-readable
  // /proc cmdline): the suite must never see the verifier key either way.
  const verifierKey = env[ENV_WITNESS_VERIFIER_KEY] ?? null;

  return startWitness({
    runId,
    token,
    proxyTarget: flagOrEnv(flags, 'proxy-target', env[ENV_PROXY_TARGET]),
    // Timing chaos (E63): the seeded release plan for proxied
    // responses. Environment-only (like the verifier key), absent in
    // every run that did not ask for chaos, and parsed fail-closed: a
    // seed the witness cannot read would produce a schedule the owner
    // could never replay.
    chaos: parseChaosOptions({
      seed: env[ENV_CHAOS_SEED],
      maxDelayMs: env[ENV_CHAOS_MAX_DELAY_MS],
      reorder: env[ENV_CHAOS_REORDER],
    }),
    // Twin path coverage (E64): the observation-only shape recording,
    // the owner's query-key allowlist, and the raw twins the supervisor
    // marked observation-only. Environment-only and absent by default,
    // so a run without `enforcement.twinPaths` is byte-identical; a
    // malformed switch or allowlist is a startup error the owner must
    // see rather than a silently key-only run.
    twinShapes: parseTwinShapePlanOrFail({
      shapes: env[ENV_TWIN_SHAPES],
      queryKeys: env[ENV_TWIN_QUERY_KEYS],
      inventoryPath: env[ENV_TWIN_INVENTORY],
    }),
    observationOnlyTestIds: observationOnlyTestIdsFrom(env[ENV_TWIN_OBSERVATION_ONLY]),
    mountPath: flagOrEnv(flags, 'mount-path', env[ENV_MOUNT_PATH]),
    stateDir: flagOrEnv(flags, 'state-dir', env[ENV_STATE_DIR]),
    classificationsPath: flagOrEnv(flags, 'classifications', env[ENV_CLASSIFICATIONS]),
    adaptersDir: flagOrEnv(flags, 'adapters-dir', env[ENV_ADAPTERS_DIR] ?? '.gateforge/adapters'),
    targetBaseUrl: flagOrEnv(flags, 'target-base-url', env[ENV_TARGET_BASE_URL]),
    targetFingerprint: flagOrEnv(flags, 'target-fingerprint', env[ENV_TARGET_FINGERPRINT]),
    adapterBaseUrl: flagOrEnv(flags, 'adapter-base-url', env[ENV_ADAPTER_BASE_URL]),
    adapterReadAuthorization:
      flagOrEnv(flags, 'adapter-read-authorization', env['GATEFORGE_ADAPTER_READ_AUTHORIZATION']) ?? null,
    // Strong behavior cases mint their fixtures and actor credentials
    // through the operator's approved provider, engine-side. Without one
    // the witness still starts and every other surface works; the cases
    // then block with a typed cause (never a suite-supplied fallback).
    fixtureProvider: await loadFixtureProvider(env[ENV_FIXTURE_PROVIDER] ?? null),
    verifierKey,
    engineBrowserLauncher: resolveEngineBrowserLauncher(),
  });
}

/**
 * Resolves the engine-browser launcher for a SPAWNED witness.
 *
 * The library surface is runner-neutral: `startWitness` takes a
 * launcher and never assumes one. This is the process entry point, and
 * a `gateforge-witness` process started by a Playwright user's
 * `test-gates` must launch that user's pinned Chromium exactly as
 * before — the ENGINE-BROWSER proof channel is a Playwright journey,
 * and losing it would be a silent downgrade of what a run can prove.
 *
 * The resolution is the same CONSUMER-FIRST one the supervised run uses
 * for the Playwright CLI: the consumer's own installed `playwright`,
 * not the engine's. When no Playwright is resolvable the witness still
 * starts and serves every other surface; an engine-browser action then
 * fails closed with a typed cause instead of a crash.
 *
 * Returns:
 *   EngineBrowserLauncher | undefined: the launcher, or undefined when
 *   no Playwright is resolvable on the module path.
 */
function resolveEngineBrowserLauncher(): EngineBrowserLauncher | undefined {
  try {
    const consumerRequire = createRequire(import.meta.url);
    return consumerRequire('playwright').chromium as EngineBrowserLauncher;
  } catch {
    return undefined;
  }
}
