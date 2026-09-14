import { UsageError } from './errors.js';
import type { Io } from './io.js';
export declare const BROKER_USAGE: string;
/** One typed broker rejection (plan Phase 5 item 6). */
export declare class BrokerRejection extends UsageError {
    /** The §5.4 cause code (or a broker-specific CAS/message marker). */
    readonly causeCode: string;
    /**
     * Args:
     *   causeCode: stable cause code (ENFORCEMENT_UNTRUSTED /
     *     EVIDENCE_STALE / RUN_INCOMPLETE / BROKER_CAS_MISMATCH /
     *     BROKER_UNSAFE_MESSAGE).
     *   detail: precise rejection reason.
     */
    constructor(causeCode: string, detail: string);
}
/**
 * Runs `gateforge broker commit` (plan Phase 5 item 6): verifies the
 * workspace candidate's gate receipt for EXACTLY those bytes, then
 * creates the authoritative commit with compare-and-swap ref protection.
 *
 * Args:
 *   io: process context (cwd = the AUTHORITATIVE repository).
 *   argv: flags after `broker commit`.
 *
 * Returns:
 *   number: 0 committed; rejections are typed errors (exit 2).
 *
 * Throws:
 *   BrokerRejection: no/stale/wrong-bytes/forged receipt, unsafe
 *     message, or CAS mismatch (no commit is created).
 *   UsageError: usage problems or git/plumbing failures.
 */
export declare function brokerCommitCommand(io: Io, argv: readonly string[]): Promise<number>;
/**
 * Runs the `broker` command family (plan Phase 5 item 6). Only `commit`
 * exists: a deliberately narrow surface — there is no unchecked
 * ref-update path.
 *
 * Args:
 *   io: process context.
 *   argv: flags + positionals after `broker`.
 *
 * Returns:
 *   Promise<number>: exit code.
 */
export declare function brokerCommand(io: Io, argv: readonly string[]): Promise<number>;
//# sourceMappingURL=broker.d.ts.map