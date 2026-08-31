import { type LedgerRow } from './ledger.js';
/**
 * The gateforge reporter. No options today; the constructor signature is
 * the Playwright reporter contract (`(options: object)`).
 */
export declare class GateforgeReporter {
    private readonly rows;
    constructor(_options?: Record<string, unknown>);
    /** Collects claims + test identity at test end (synchronous). */
    onTestEnd(test: {
        id: string;
        annotations?: Array<{
            type: string;
            description?: string;
        }>;
        location?: {
            file: string;
            line: number;
            column: number;
        };
    }, result: {
        status: string;
    }): void;
    /** Writes the run-state artifacts and prints the gate ledger. */
    onEnd(): Promise<void>;
    /** The witness classification projection (real lifecycle + primaryKey). */
    private fetchClassifications;
    private ledgerRows;
    /** Deterministic instant: the run manifest's injected `startedAt`. */
    private runInstant;
    /** Prints the per-claim verdict ledger + gate summary. */
    private printLedger;
    /** GF-24 observability: obligations nobody claimed + records nobody claimed. */
    private printRegistryMismatches;
}
export default GateforgeReporter;
export type { LedgerRow };
//# sourceMappingURL=reporter.d.ts.map