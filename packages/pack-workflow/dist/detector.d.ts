import type { DiscoveryOutcome } from '@gateforge/plugin-protocol';
/** Stable detector kind for every workflow resource this pack emits. */
export declare const WORKFLOW_CONTRACT_KIND = "workflow.contract";
/** FSM style enumeration; one per detected machine. */
export type FsmStyle = 'xstate' | 'fsm' | 'enum-switch' | 'zustand-slice';
/** One transition extracted from an FSM source. */
export interface WorkflowTransition {
    from: string;
    to: string;
    /** Logical event name (XState `on.<event>` / switch `case` key / Zustand action). */
    action: string;
}
/** Attribute payload of a {@link WORKFLOW_CONTRACT_KIND} resource. */
export interface WorkflowContractAttributes {
    resourceName: string;
    states: string[];
    transitions: WorkflowTransition[];
    terminal: string[];
    auditEvent: boolean;
    style: FsmStyle;
    domain: string;
}
/** Options for {@link createWorkflowDetector}. */
export interface WorkflowDetectorOptions {
    /** Repo root used to compute repo-root-relative `source` paths. */
    cwd?: string;
    /** Detector version override; primarily tests. */
    detectorVersion?: string;
    /** Detector id override; primarily tests. */
    detectorId?: string;
}
/** The pinned in-process plugin contract: `{ discover(paths) }`. */
export interface WorkflowDetector {
    discover(paths: readonly string[]): Promise<DiscoveryOutcome>;
}
/**
 * Creates a discover-capable detector module. The default export of the
 * pack is `createWorkflowDetector()` — the CLI in-process contract.
 *
 * Args:
 *   options: Detector configuration (cwd, identity overrides).
 *
 * Returns:
 *   WorkflowDetector: the pinned `{ discover(paths) }` module.
 */
export declare function createWorkflowDetector(options?: WorkflowDetectorOptions): WorkflowDetector;
//# sourceMappingURL=detector.d.ts.map