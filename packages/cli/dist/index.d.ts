/**
 * @gateforge/cli — the gateforge command-line interface.
 *
 * Public surface for the bin wrapper and for programmatic embedding
 * (tests, G6's test-gates integration):
 *
 * - {@link main}: argv → exit code, with injectable cwd/env/streams.
 * - protocol constants: {@link DEFAULT_STATE_DIR} and the test-gates
 *   state layout (see src/state.ts).
 * - provider machinery: {@link resolveProvider} and the three diff
 *   providers (pin #5).
 */
export { main, USAGE } from './cli.js';
export { VERSION } from './commands/common.js';
export { DEFAULT_STATE_DIR, resolveStateDir, readJsonArray, writeManifest, writeObligations, writeEnv, writeReport, stateObligations, } from './state.js';
export type { StateObligation, TestGatesEnv } from './state.js';
export { localStagedProvider, githubPrProvider, gitlabMrProvider, providerFor, resolveProvider, } from './providers.js';
export type { ChangedFileProvider } from '@gateforge/core';
export { runPipeline, sourceByResourceId, headSha, loadYaml } from './pipeline.js';
export type { PipelineOptions, PipelineResult } from './pipeline.js';
export { APPROVED_POLICY_DIGEST_ENV, TRUSTED_CONFIG_ENV, WEAKENED_POLICY_NEXT_ACTION, PROVISION_PIN_NEXT_ACTION, RESEAL_NEXT_ACTION, assertApprovedPolicy, assertReceiptApprovedPolicy, describeApprovedPolicyResolution, evaluateApprovedPolicy, resolveApprovedPolicyDigest, } from './trusted-policy.js';
export type { ApprovedPolicyGate, ApprovedPolicyInput, ApprovedPolicyOrigin, ApprovedPolicyResolution, ApprovedPolicyResult, } from './trusted-policy.js';
export { runPlugins } from './plugins.js';
export type { PluginRunResult, InProcessPluginModule } from './plugins.js';
export { evaluateRun } from './evaluate.js';
export type { EvaluateInput, EvaluateResult } from './evaluate.js';
export { expandIncludePaths } from './glob.js';
export type { Io } from './io.js';
export { CaptureStream, processIo } from './io.js';
//# sourceMappingURL=index.d.ts.map