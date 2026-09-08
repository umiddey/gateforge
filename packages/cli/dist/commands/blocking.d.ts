import type { Io } from '../io.js';
/** Ensures the check-gate hook script exists (executable). */
export declare function ensureHookScript(io: Io): string;
/** Appends the gateforge-check hook to .pre-commit-config.yaml (idempotent). */
export declare function appendPreCommitHook(io: Io): void;
/** Writes the GitLab CI job template + include wiring (idempotent). */
export declare function writeGitlabCiTemplate(io: Io): void;
/** Wires everything: hook script + pre-commit block + CI template. */
export declare function ensureBlockingWiring(io: Io): void;
//# sourceMappingURL=blocking.d.ts.map