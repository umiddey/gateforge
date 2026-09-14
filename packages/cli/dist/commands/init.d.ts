import type { Io } from '../io.js';
export declare const INIT_USAGE = "usage: gateforge init [--languages <comma,list>] [--blocking] [--strict-e2e]";
/**
 * The starter policies document (plan phase 5): the gradable
 * `persistence:*` namespace for automatically classified resources.
 * UI-semantic `crud:*` stays opt-in and visibly fail-closed until a
 * trusted UI observer exists (ADR 0003 §3).
 */
/**
 * Opt-in transport-only endpoint policy (plan §8 / D1): proves only that
 * the witness observed a matching HTTP exchange in the bound run. Test
 * attribution is suite-claimed — it does not prove which browser, UI
 * action, or test produced the exchange. Selecting this document
 * changes the guarantee: it is a SEPARATE opt-in policy, never an
 * automatic migration of the default frontend requirement, baselines,
 * or waivers.
 */
export declare const TRANSPORT_ONLY_POLICY_EXAMPLE = "# Transport-only endpoint policy (plan \u00A78 / D1, explicit opt-in).\n# Each obligation proves only that the witness observed a matching HTTP\n# exchange in the bound run (\"witness observed an HTTP exchange\");\n# test attribution is suite-claimed (\"suite-claimed\"), never proven\n# browser-issued by an independent channel. Selecting this policy narrows the\n# guarantee relative to the default frontend requirement below.\nschemaVersion: 1\npolicies:\n  - id: frontend-consumed-endpoints-transport-only\n    when:\n      kind: http.endpoint\n      consumed: true\n    require:\n      - http:request-observed\n      - http:response-status-ok\n";
export declare const POLICIES_TEMPLATE = "# Declarative policies: when a resource matches, the required contracts\n# become obligations. Lifecycle-gated persistence:* contracts are emitted\n# only for the lifecycle operations the automatic classification enables,\n# and are graded on the witness's own engine-side observation.\n# UI-semantic crud:* contracts intentionally fail closed (no\n# witness-controlled UI observation channel exists yet) \u2014 add them only\n# deliberately.\nschemaVersion: 1\npolicies:\n  - id: frontend-consumed-endpoints\n    # ADR 0004 D8 + plan \u00A78 / D1: only endpoints the frontend actually\n    # consumes (static join) owe browser-exercise obligations;\n    # server-only routes never do. NOTE: 'http:frontend-request-observed'\n    # is BLOCKING with the current observer \u2014 no independent\n    # browser/test observation channel exists yet, so the verifier\n    # returns missing before examining evidence (test attribution is\n    # suite-claimed). Keep this requirement to hold the frontend-proof\n    # bar; or SEPARATELY opt in to the narrower transport-only policy\n    # (TRANSPORT_ONLY_POLICY_EXAMPLE: 'http:request-observed', proving\n    # only a witness-observed HTTP exchange) when that smaller guarantee\n    # suffices. Never auto-migrate policies, baselines, or waivers.\n    when:\n      kind: http.endpoint\n      consumed: true\n    require:\n      - http:frontend-request-observed\n      - http:response-status-ok\n  # Capability-scoped endpoint policies (workflow/validation/...) may be added\n  # ONLY when the owning pack ships an engine-owned state-observing producer;\n  # until then those contracts cannot be honestly evidenced and stay blocking.\n  - id: user-facing-persistence\n    when:\n      exposure: user-facing\n    require:\n      - persistence:create\n      - persistence:read\n      - persistence:update\n      - persistence:delete\n";
/**
 * Runs `gateforge init` in the io cwd.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code (0).
 */
export declare function initCommand(io: Io, argv: readonly string[]): Promise<number>;
//# sourceMappingURL=init.d.ts.map