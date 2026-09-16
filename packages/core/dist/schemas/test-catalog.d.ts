/**
 * Test-catalog schemas (plan 2026-09-13 §5.1 row 1 + §5.2): the derived
 * inventory of a repository's existing tests.
 *
 * Identity rules (§5.2, hard):
 * - The `logicalKey` is the stable manual-mapping identity: an explicit
 *   slug when a mapping declares one, otherwise deterministically derived
 *   from runner + project + repo-relative file + full title path
 *   ({@link deriveLogicalKey}).
 * - Line numbers are DIAGNOSTICS, never identity: adding a comment keeps
 *   the logical key stable while `sourceDigest` changes.
 * - Duplicate logical keys are a typed parse error listing BOTH sources —
 *   never "bind the first match".
 *
 * Discovery is data, not a gate result: `unresolved` entries and
 * `parseErrors` are first-class catalog rows so a failed scan can never
 * be misread as "no tests".
 */
import { z } from 'zod';
/** Runner names with an implemented adapter (plan phase 2 item 6). */
export declare const SUPPORTED_TEST_RUNNERS: readonly ["playwright", "pytest"];
/**
 * A runner name. `playwright` and `pytest` are the adapters implemented
 * so far; any other string is legal data (an adapter must exist before
 * its entries drive gates — plan phase 2 item 6).
 */
export declare const TestRunnerSchema: z.ZodString;
/** Inferred test-runner type. */
export type TestRunner = z.infer<typeof TestRunnerSchema>;
/**
 * What a test IS (plan §3.2). `unknown` is a kept, visible outcome.
 *
 * `server-e2e` (server-witnessed persistence channel) declares an
 * existing test whose persistence evidence is witnessed SERVER-side:
 * the engine's own adapter probe observes the app database directly,
 * because the obligated state (e.g. a transactional outbox) can never
 * honestly appear in a UI. Browser-kind tests never grade through it —
 * the witness stamps the channel only for obligations registered
 * `server-e2e` on the verifier-key supervisor surface, and the verdict
 * engine admits `channel: 'server'` records only with that stamp.
 */
export declare const TestKindSchema: z.ZodEnum<{
    unknown: "unknown";
    "browser-e2e": "browser-e2e";
    "server-e2e": "server-e2e";
    "api-e2e": "api-e2e";
    unit: "unit";
    integration: "integration";
    component: "component";
}>;
/** Inferred test-kind type. */
export type TestKind = z.infer<typeof TestKindSchema>;
/** Catalog row discovery status (plan §5.1 row 1). */
export declare const DiscoveryStatusSchema: z.ZodEnum<{
    unresolved: "unresolved";
    discovered: "discovered";
    "parse-error": "parse-error";
}>;
/** Inferred discovery-status type. */
export type DiscoveryStatus = z.infer<typeof DiscoveryStatusSchema>;
/** Reconciliation outcome against the runner's native enumeration. */
export declare const ReconciliationStatusSchema: z.ZodEnum<{
    matched: "matched";
    "static-only": "static-only";
    "list-only": "list-only";
    unavailable: "unavailable";
}>;
/** Inferred reconciliation-status type. */
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>;
/** One inference rule that fired, with the code location that fed it. */
export declare const RuleEvidenceSchema: z.ZodObject<{
    ruleId: z.ZodString;
    evidence: z.ZodString;
    location: z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strict>;
/** Inferred rule-evidence type. */
export type RuleEvidence = z.infer<typeof RuleEvidenceSchema>;
/**
 * A strong kind signal: a rule that proposes a {@link TestKind} with its
 * code evidence. Conflicting proposals resolve to `unknown` — never to
 * whichever rule ran last (plan phase 2 item 5: no opaque confidence).
 */
export declare const KindSignalSchema: z.ZodObject<{
    ruleId: z.ZodString;
    evidence: z.ZodString;
    location: z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>;
    kind: z.ZodEnum<{
        unknown: "unknown";
        "browser-e2e": "browser-e2e";
        "server-e2e": "server-e2e";
        "api-e2e": "api-e2e";
        unit: "unit";
        integration: "integration";
        component: "component";
    }>;
}, z.core.$strict>;
/** Inferred kind-signal type. */
export type KindSignal = z.infer<typeof KindSignalSchema>;
/**
 * A weak signal (title/folder hints). Weak signals are recorded for the
 * agent but must NEVER decide a kind by themselves (plan §3.2).
 */
export declare const WeakSignalSchema: z.ZodObject<{
    ruleId: z.ZodString;
    evidence: z.ZodString;
    location: z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strict>;
/** Inferred weak-signal type. */
export type WeakSignal = z.infer<typeof WeakSignalSchema>;
/**
 * A behavior-category hint (plan §3.2): extensible dotted labels such as
 * `persistence.create`. Hints only — a label never creates or satisfies
 * a contract.
 */
export declare const CategorySignalSchema: z.ZodObject<{
    label: z.ZodString;
    ruleId: z.ZodString;
    location: z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strict>;
/** Inferred category-signal type. */
export type CategorySignal = z.infer<typeof CategorySignalSchema>;
/**
 * Suppression/mock signals: skip, only, fixme, and known mock patterns.
 * These qualify (and can disqualify) later proof; discovery only records
 * them with locations (plan §3.2/§3.3).
 */
export declare const SuppressionSignalKindSchema: z.ZodEnum<{
    skip: "skip";
    only: "only";
    fixme: "fixme";
    mock: "mock";
}>;
/** Inferred suppression-signal-kind type. */
export type SuppressionSignalKind = z.infer<typeof SuppressionSignalKindSchema>;
/** One recorded suppression/mock signal with its location. */
export declare const SuppressionSignalSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        skip: "skip";
        only: "only";
        fixme: "fixme";
        mock: "mock";
    }>;
    detail: z.ZodString;
    location: z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strict>;
/** Inferred suppression-signal type. */
export type SuppressionSignal = z.infer<typeof SuppressionSignalSchema>;
/**
 * One catalog row (plan §5.1 row 1): what test exists, plus the signals
 * discovery gathered. Rows are NEVER dropped — an unresolvable call is
 * a row with `discoveryStatus: 'unresolved'`, not an omission.
 */
export declare const TestCatalogEntrySchema: z.ZodObject<{
    logicalKey: z.ZodString;
    runner: z.ZodString;
    project: z.ZodNullable<z.ZodString>;
    file: z.ZodString;
    titlePath: z.ZodArray<z.ZodString>;
    title: z.ZodString;
    sourceLocation: z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>;
    parameterIdentity: z.ZodNullable<z.ZodString>;
    sourceDigest: z.ZodString;
    resolutionOrigin: z.ZodOptional<z.ZodEnum<{
        static: "static";
        "native-list": "native-list";
    }>>;
    discoveryStatus: z.ZodEnum<{
        unresolved: "unresolved";
        discovered: "discovered";
        "parse-error": "parse-error";
    }>;
    reconciliation: z.ZodEnum<{
        matched: "matched";
        "static-only": "static-only";
        "list-only": "list-only";
        unavailable: "unavailable";
    }>;
    inferredKind: z.ZodEnum<{
        unknown: "unknown";
        "browser-e2e": "browser-e2e";
        "server-e2e": "server-e2e";
        "api-e2e": "api-e2e";
        unit: "unit";
        integration: "integration";
        component: "component";
    }>;
    kindSignals: z.ZodArray<z.ZodObject<{
        ruleId: z.ZodString;
        evidence: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
        kind: z.ZodEnum<{
            unknown: "unknown";
            "browser-e2e": "browser-e2e";
            "server-e2e": "server-e2e";
            "api-e2e": "api-e2e";
            unit: "unit";
            integration: "integration";
            component: "component";
        }>;
    }, z.core.$strict>>;
    weakSignals: z.ZodArray<z.ZodObject<{
        ruleId: z.ZodString;
        evidence: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    rulesFired: z.ZodArray<z.ZodObject<{
        ruleId: z.ZodString;
        evidence: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    categorySignals: z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        ruleId: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    suppressionSignals: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            skip: "skip";
            only: "only";
            fixme: "fixme";
            mock: "mock";
        }>;
        detail: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    unresolvedReason: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        detail: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred test-catalog-entry type. */
export type TestCatalogEntry = z.infer<typeof TestCatalogEntrySchema>;
/** One parser failure with its source location (never swallowed). */
export declare const CatalogParseErrorSchema: z.ZodObject<{
    file: z.ZodString;
    message: z.ZodString;
    location: z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strict>;
/** Inferred catalog-parse-error type. */
export type CatalogParseError = z.infer<typeof CatalogParseErrorSchema>;
/** One runner-level summary line (playwright reconciliation, pytest suites). */
export declare const RunnerSummarySchema: z.ZodObject<{
    runner: z.ZodString;
    name: z.ZodString;
    status: z.ZodEnum<{
        discovered: "discovered";
        unavailable: "unavailable";
        registered: "registered";
    }>;
    detail: z.ZodString;
}, z.core.$strict>;
/** Inferred runner-summary type. */
export type RunnerSummary = z.infer<typeof RunnerSummarySchema>;
/**
 * The derived test catalog (plan §5.1). Every case is a row in
 * `entries`; `unresolved` and `parseErrors` are the typed roll-ups of
 * the rows needing attention. `inventoryComplete` captures scan
 * completeness SEPARATELY from classification uncertainty: `unknown`
 * kinds do not make an inventory incomplete, a failed scan does.
 */
export declare const TestCatalogSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    entries: z.ZodArray<z.ZodObject<{
        logicalKey: z.ZodString;
        runner: z.ZodString;
        project: z.ZodNullable<z.ZodString>;
        file: z.ZodString;
        titlePath: z.ZodArray<z.ZodString>;
        title: z.ZodString;
        sourceLocation: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
        parameterIdentity: z.ZodNullable<z.ZodString>;
        sourceDigest: z.ZodString;
        resolutionOrigin: z.ZodOptional<z.ZodEnum<{
            static: "static";
            "native-list": "native-list";
        }>>;
        discoveryStatus: z.ZodEnum<{
            unresolved: "unresolved";
            discovered: "discovered";
            "parse-error": "parse-error";
        }>;
        reconciliation: z.ZodEnum<{
            matched: "matched";
            "static-only": "static-only";
            "list-only": "list-only";
            unavailable: "unavailable";
        }>;
        inferredKind: z.ZodEnum<{
            unknown: "unknown";
            "browser-e2e": "browser-e2e";
            "server-e2e": "server-e2e";
            "api-e2e": "api-e2e";
            unit: "unit";
            integration: "integration";
            component: "component";
        }>;
        kindSignals: z.ZodArray<z.ZodObject<{
            ruleId: z.ZodString;
            evidence: z.ZodString;
            location: z.ZodObject<{
                file: z.ZodString;
                line: z.ZodNumber;
                col: z.ZodNumber;
            }, z.core.$strict>;
            kind: z.ZodEnum<{
                unknown: "unknown";
                "browser-e2e": "browser-e2e";
                "server-e2e": "server-e2e";
                "api-e2e": "api-e2e";
                unit: "unit";
                integration: "integration";
                component: "component";
            }>;
        }, z.core.$strict>>;
        weakSignals: z.ZodArray<z.ZodObject<{
            ruleId: z.ZodString;
            evidence: z.ZodString;
            location: z.ZodObject<{
                file: z.ZodString;
                line: z.ZodNumber;
                col: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>>;
        rulesFired: z.ZodArray<z.ZodObject<{
            ruleId: z.ZodString;
            evidence: z.ZodString;
            location: z.ZodObject<{
                file: z.ZodString;
                line: z.ZodNumber;
                col: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>>;
        categorySignals: z.ZodArray<z.ZodObject<{
            label: z.ZodString;
            ruleId: z.ZodString;
            location: z.ZodObject<{
                file: z.ZodString;
                line: z.ZodNumber;
                col: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>>;
        suppressionSignals: z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<{
                skip: "skip";
                only: "only";
                fixme: "fixme";
                mock: "mock";
            }>;
            detail: z.ZodString;
            location: z.ZodObject<{
                file: z.ZodString;
                line: z.ZodNumber;
                col: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>>;
        unresolvedReason: z.ZodOptional<z.ZodObject<{
            code: z.ZodString;
            detail: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    unresolved: z.ZodArray<z.ZodObject<{
        logicalKey: z.ZodString;
        code: z.ZodString;
        detail: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    parseErrors: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        message: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    inventoryComplete: z.ZodBoolean;
    runnerSummaries: z.ZodArray<z.ZodObject<{
        runner: z.ZodString;
        name: z.ZodString;
        status: z.ZodEnum<{
            discovered: "discovered";
            unavailable: "unavailable";
            registered: "registered";
        }>;
        detail: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred test-catalog type. */
export type TestCatalog = z.infer<typeof TestCatalogSchema>;
/** One catalog roll-up row (inferred, for builders). */
export type CatalogUnresolved = z.infer<(typeof TestCatalogSchema)['shape']['unresolved']['element']>;
/** Inputs of the deterministic logical-key derivation (§5.2). */
export interface LogicalKeyInput {
    /** Runner name, e.g. `playwright`. */
    runner: string;
    /** Runner project, or `null` when none is bound yet. */
    project: string | null;
    /** Repo-root-relative posix file path. */
    file: string;
    /** Full title path (describe stack + title). */
    titlePath: readonly string[];
}
/**
 * Derives the deterministic logical key for a test (§5.2): runner,
 * project (`-` when unbound), repo-relative file, then the full title
 * path joined with `>`. Pure string shaping — stable across line moves
 * and comment edits (line numbers are never identity input).
 *
 * Args:
 *   input: runner, project, file, and title path.
 *
 * Returns:
 *   string: e.g. `playwright:chromium:e2e/accounts.spec.ts:Accounts>creates an account`.
 */
export declare function deriveLogicalKey(input: LogicalKeyInput): string;
//# sourceMappingURL=test-catalog.d.ts.map