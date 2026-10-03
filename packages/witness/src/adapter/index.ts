/**
 * `@gate-forge/witness/adapter` — the runner-adapter contract and the
 * conformance suite every runner must pass (plan 2026-09-25 phase 0).
 */
export type {
  RunnerAdapter,
  RunnerChildEnv,
  RunnerChildEnvContext,
  RunnerEnumeration,
  RunnerExecuteRequest,
  RunnerName,
  RunnerRawResults,
  RunnerSessionTag,
  RunnerTagChannel,
  RunnerTestIdentity,
} from './contract.js';
export type {
  ContractObservation,
  ContractScenario,
  ContractScenarioKind,
  ContractViolation,
  RunnerContractHost,
} from './contract-suite.js';
export { CONTRACT_SCENARIOS, contractScenario, runRunnerAdapterContract } from './contract-suite.js';
