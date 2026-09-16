/**
 * Fixture harness (G7): deterministic temporary git repositories,
 * injected clocks and environments, the gate-runner pipeline, the GF-19
 * malformed-source rule, and the RED-PROBE discipline. Everything here is
 * offline and wall-clock-free; the public surface is re-exported from
 * `@gate-forge/core`.
 */
export { FIXED_GIT_DATE, TempRepo, withTempRepo, } from './temp-repo.js';
export { makeClock, toIso } from './clock.js';
export { fakeProvider, localStagedProvider, normalizeChangedFiles, withEnv, } from './env.js';
export { PARSE_ERROR_FINDING, applyParseErrorRule, hasParseErrors, stubDetector, } from './gf19.js';
export { runGates } from './gate-runner.js';
export { RedProbeFailure, RedProbeSuiteError, cleanupProbeSuite, formatProbeRecords, runRedProbe, runRedProbes, spawnVitest, writeProbeRecords, writeProbeSuite, } from './red-probe.js';
//# sourceMappingURL=index.js.map