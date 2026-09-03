import type { Io } from '../io.js';
export declare const INIT_USAGE = "usage: gateforge init [--languages <comma,list>]";
/**
 * The starter policies document (plan phase 5): the gradable
 * `persistence:*` namespace for automatically classified resources.
 * UI-semantic `crud:*` stays opt-in and visibly fail-closed until a
 * trusted UI observer exists (ADR 0003 §3).
 */
export declare const POLICIES_TEMPLATE = "# Declarative policies: when a resource matches, the required contracts\n# become obligations. Lifecycle-gated persistence:* contracts are emitted\n# only for the lifecycle operations the automatic classification enables,\n# and are graded on the witness's own engine-side observation.\n# UI-semantic crud:* contracts intentionally fail closed (no\n# witness-controlled UI observation channel exists yet) \u2014 add them only\n# deliberately.\nschemaVersion: 1\npolicies:\n  - id: frontend-consumed-endpoints\n    # ADR 0004 D8: only endpoints the frontend actually consumes (static\n    # join) owe browser-exercise obligations; server-only routes never do.\n    when:\n      kind: http.endpoint\n      consumed: true\n    require:\n      - http:frontend-request-observed\n      - http:response-status-ok\n  # Capability-scoped endpoint policies (workflow/validation/...) may be added\n  # ONLY when the owning pack ships an engine-owned state-observing producer;\n  # until then those contracts cannot be honestly evidenced and stay blocking.\n  - id: user-facing-persistence\n    when:\n      exposure: user-facing\n    require:\n      - persistence:create\n      - persistence:read\n      - persistence:update\n      - persistence:delete\n";
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
export declare function initCommand(io: Io, argv: readonly string[]): number;
//# sourceMappingURL=init.d.ts.map