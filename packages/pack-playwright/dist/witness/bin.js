/**
 * Witness process entry (`gateforge-witness`): derives configuration
 * from the environment and starts the loopback witness service.
 *
 * Env surface:
 *   GATEFORGE_RUN_ID, GATEFORGE_RUN_TOKEN        (required; CLI contract)
 *   GATEFORGE_STATE_DIR                          (manifest append at shutdown)
 *   GATEFORGE_ADAPTERS_DIR                       (default .gateforge/adapters)
 *   GATEFORGE_CLASSIFICATIONS                    (classifications YAML path)
 *   GATEFORGE_TARGET_BASE_URL                    (attestation subject, GF-10)
 *   GATEFORGE_TARGET_FINGERPRINT                 (expected marker, GF-13)
 *   GATEFORGE_ADAPTER_BASE_URL                   (default adapter read base)
 *
 * The wrapper prints `GATEFORGE_WITNESS_URL=<url>` once listening; the
 * process serves until SIGTERM/SIGINT.
 */
import { startWitness, WitnessStartupError } from './server.js';
import { ENV_ADAPTER_BASE_URL, ENV_ADAPTERS_DIR, ENV_CLASSIFICATIONS, ENV_RUN_ID, ENV_RUN_TOKEN, ENV_STATE_DIR, ENV_TARGET_BASE_URL, ENV_TARGET_FINGERPRINT, } from '../constants.js';
/**
 * Reads env and starts the witness.
 *
 * Args:
 *   argv: unused (reserved for flags).
 *   env: process environment.
 *
 * Returns:
 *   WitnessHandle once listening.
 *
 * Throws:
 *   WitnessStartupError / AttestationError / AdapterRegistryError:
 *     fail-closed startup problems (exit 2 via the wrapper).
 */
export async function main(argv, env) {
    void argv;
    const runId = env[ENV_RUN_ID];
    const token = env[ENV_RUN_TOKEN];
    if (runId === undefined || runId === '') {
        throw new WitnessStartupError(`${ENV_RUN_ID} is required (set by 'gateforge test-gates')`);
    }
    if (token === undefined || token === '') {
        throw new WitnessStartupError(`${ENV_RUN_TOKEN} is required (set by 'gateforge test-gates')`);
    }
    const stateDir = env[ENV_STATE_DIR] ?? null;
    const adaptersDir = env[ENV_ADAPTERS_DIR] ?? '.gateforge/adapters';
    const classificationsPath = env[ENV_CLASSIFICATIONS] ?? null;
    const targetBaseUrl = env[ENV_TARGET_BASE_URL] ?? null;
    const targetFingerprint = env[ENV_TARGET_FINGERPRINT] ?? null;
    const adapterBaseUrl = env[ENV_ADAPTER_BASE_URL] ?? null;
    return startWitness({
        runId,
        token,
        stateDir,
        adaptersDir,
        classificationsPath,
        targetBaseUrl,
        targetFingerprint,
        adapterBaseUrl,
    });
}
//# sourceMappingURL=bin.js.map