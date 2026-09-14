import type { Io } from '../io.js';
export declare const ENFORCEMENT_USAGE = "usage: gateforge enforcement doctor [--json]";
/** Status of one doctor check. */
export type DoctorStatus = 'ok' | 'warn' | 'fail';
/** One deterministic doctor check result. */
export interface DoctorCheck {
    /** Stable check id (e.g. `hook`, `managed-guarantee`). */
    id: string;
    /** ok / warn / fail — fail means the reported boundary is broken. */
    status: DoctorStatus;
    /** Precise, honest detail (no false protection claims). */
    detail: string;
}
/** The complete doctor report (checks in stable order + overall). */
export interface DoctorReport {
    /** Enforcement mode from config (default standard). */
    mode: 'standard' | 'managed';
    /** Whether strict E2E mode is enabled in config. */
    strictE2E: boolean;
    /** Per-check results in stable id order. */
    checks: DoctorCheck[];
    /** True when no check has status `fail`. */
    ready: boolean;
}
/**
 * Builds the doctor report (all checks, honest statuses).
 *
 * Args:
 *   io: process context.
 *
 * Returns:
 *   Promise<DoctorReport>: deterministic report.
 */
export declare function buildDoctorReport(io: Io): Promise<DoctorReport>;
/**
 * Runs the `enforcement doctor` subcommand (plan Phase 5 item 7).
 *
 * Args:
 *   io: process context.
 *   argv: flags after `enforcement`.
 *
 * Returns:
 *   Promise<number>: always 0 when the doctor runs (diagnostic);
 *   2 for usage errors.
 */
export declare function enforcementCommand(io: Io, argv: readonly string[]): Promise<number>;
//# sourceMappingURL=enforcement.d.ts.map