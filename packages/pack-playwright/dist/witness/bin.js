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
import { ENV_ADAPTER_BASE_URL, ENV_ADAPTERS_DIR, ENV_CLASSIFICATIONS, ENV_MOUNT_PATH, ENV_PROXY_TARGET, ENV_RUN_ID, ENV_RUN_TOKEN, ENV_STATE_DIR, ENV_TARGET_BASE_URL, ENV_TARGET_FINGERPRINT, ENV_WITNESS_VERIFIER_KEY, } from '../constants.js';
/** One-line usage (the header comment above is the long form). */
export const WITNESS_BIN_USAGE = 'usage: gateforge-witness [--proxy-target <url>] [--mount-path <prefix>] ' +
    '[--state-dir <dir>] [--classifications <path>] [--adapters-dir <dir>] ' +
    '[--target-base-url <url>] [--target-fingerprint <marker>] [--adapter-base-url <url>] ' +
    '(run id/token via GATEFORGE_RUN_ID/GATEFORGE_RUN_TOKEN; verifier key via ' +
    'GATEFORGE_WITNESS_VERIFIER_KEY)';
/** Flags this bin accepts (values; `--help` is handled separately). */
const VALUE_FLAGS = new Set([
    'proxy-target',
    'mount-path',
    'state-dir',
    'classifications',
    'adapters-dir',
    'target-base-url',
    'target-fingerprint',
    'adapter-base-url',
]);
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
function parseFlags(argv) {
    const values = new Map();
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
        let value = eq >= 0 ? body.slice(eq + 1) : undefined;
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
function flagOrEnv(flags, name, envValue) {
    const fromFlags = flags.values.get(name);
    if (fromFlags !== undefined && fromFlags !== '')
        return fromFlags;
    if (envValue !== undefined && envValue !== '')
        return envValue;
    return undefined;
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
export async function main(argv, env) {
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(`${WITNESS_BIN_USAGE}\n`);
        return Object.freeze({ url: '', proxyUrl: null, stop: async () => { } });
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
        mountPath: flagOrEnv(flags, 'mount-path', env[ENV_MOUNT_PATH]),
        stateDir: flagOrEnv(flags, 'state-dir', env[ENV_STATE_DIR]),
        classificationsPath: flagOrEnv(flags, 'classifications', env[ENV_CLASSIFICATIONS]),
        adaptersDir: flagOrEnv(flags, 'adapters-dir', env[ENV_ADAPTERS_DIR] ?? '.gateforge/adapters'),
        targetBaseUrl: flagOrEnv(flags, 'target-base-url', env[ENV_TARGET_BASE_URL]),
        targetFingerprint: flagOrEnv(flags, 'target-fingerprint', env[ENV_TARGET_FINGERPRINT]),
        adapterBaseUrl: flagOrEnv(flags, 'adapter-base-url', env[ENV_ADAPTER_BASE_URL]),
        verifierKey,
    });
}
//# sourceMappingURL=bin.js.map