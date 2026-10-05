/**
 * `scan:` — the SCANNER settings section of `.gateforge.yml` (0.11.0).
 *
 * These four settings used to live in `classification-policy.yml`
 * (`scanRoots`, `coverage`, `declarations`, `volatileFields`). They moved
 * here for ONE reason: they are not owner ANSWERS, they are machine-wide
 * scan configuration, and the answers file now holds exactly the answers.
 * They are still inside the owner-approved policy digest, because
 * `.gateforge.yml` is a trusted-policy input like every other declaration
 * there — the move changes which document an agent has to edit, never who
 * has to approve it.
 *
 * The section also carries the two detector configuration documents that
 * used to be their own files (`scan.httpClients`, was
 * `.gateforge/http-clients.json`; `scan.fastapi`, was
 * `.gateforge/fastapi.json`), for the same reason and with the same
 * rule: the SHAPE is checked here, the RULES by the detector that applies
 * them (one validation source, unchanged from the readers that have always
 * guarded them).
 */
import { z } from 'zod';
import { CoverageRuleSchema } from './classification-policy.js';
import type { ClassificationPolicy } from './classification-policy.js';

/**
 * One owner-declared HTTP client-scan section (was
 * `.gateforge/http-clients.json`). Shape here; the client-symbol /
 * wrapper / URL-builder / same-origin rules are validated by pack-http's
 * own reader, which is the single source of truth for that document.
 */
export const HttpClientsScanSectionSchema = z
  .object({
    /** Instance symbols exposing verb methods, e.g. `['apiClient']`. */
    clientSymbols: z.array(z.unknown()).optional(),
    /** Wrapper callables with the concrete method they always issue. */
    wrapperFunctions: z.array(z.unknown()).optional(),
    /** Pure URL builders with an optional literal base. */
    urlBuilders: z.array(z.unknown()).optional(),
    /** Absolute-URL hosts treated as same-origin. */
    sameOriginHosts: z.array(z.unknown()).optional(),
    /** Globs limiting client-call scanning. */
    clientScanRoots: z.array(z.unknown()).optional(),
    /** Globs limiting generic server-route scanning. */
    serverScanRoots: z.array(z.unknown()).optional(),
  })
  .strict();

/** Inferred `scan.httpClients` shape. */
export type HttpClientsScanSection = z.infer<typeof HttpClientsScanSectionSchema>;

/**
 * One owner-declared FastAPI scan section (was `.gateforge/fastapi.json`):
 * repo-root-relative directories acting as Python import roots.
 */
export const FastapiScanSectionSchema = z
  .object({
    /** Repo-root-relative import roots for ABSOLUTE imports. */
    importRoots: z.array(z.unknown()).optional(),
  })
  .strict();

/** Inferred `scan.fastapi` shape. */
export type FastapiScanSection = z.infer<typeof FastapiScanSectionSchema>;

/**
 * The `scan:` section of `.gateforge.yml`. REQUIRED: a repository without
 * it has not answered "what does a closed-world proof have to cover", and
 * defaulting that would silently weaken every suppressive decision. The
 * key lives in `.gateforge.yml`, so it is inside the trusted policy
 * digest exactly like the settings it replaces.
 */
export const ScanConfigSchema = z
  .object({
    /**
     * Repo-root-relative globs defining the scope a closed-world proof
     * must cover. A non-empty list is the prerequisite of every
     * complete-scan attestation (ADR 0003 D4).
     */
    scanRoots: z.array(z.string().min(1)).min(1),
    /**
     * Coverage requirements for COMPLETE-scan proofs (ADR 0003 D4). A
     * closed-world attestation holds only when every rule's detector is
     * configured, reports coverage, and covers every applicable requested
     * file. Declaring none means no scan is provably complete — closed-
     * world proofs stay unavailable (fail closed).
     */
    coverage: z.array(CoverageRuleSchema).optional(),
    /**
     * Supported source declaration syntax: the machine-readable keys
     * detectors may translate into declaration signals (e.g.
     * `internality: 'gateforge:internal'`).
     */
    declarations: z.record(z.string(), z.string().min(1)),
    /**
     * Bookkeeping columns that never satisfy an update by themselves
     * (mirrors the verdict engine's `updateableFields` fail-closed rule).
     */
    volatileFields: z.array(z.string().min(1)),
    /** HTTP client-scan settings (was `.gateforge/http-clients.json`). */
    httpClients: HttpClientsScanSectionSchema.optional(),
    /** FastAPI import roots (was `.gateforge/fastapi.json`). */
    fastapi: FastapiScanSectionSchema.optional(),
  })
  .strict();

/** Inferred `scan:` section shape. */
export type ScanConfig = z.infer<typeof ScanConfigSchema>;

/** The scanner keys that used to live in `classification-policy.yml`. */
export const MOVED_SCANNER_KEYS = ['scanRoots', 'coverage', 'declarations', 'volatileFields'] as const;

/** Union of the moved scanner keys. */
export type MovedScannerKey = (typeof MOVED_SCANNER_KEYS)[number];

/** Whether `key` is one of the scanner settings that moved to `.gateforge.yml`. */
export function isMovedScannerKey(key: string): key is MovedScannerKey {
  return (MOVED_SCANNER_KEYS as readonly string[]).includes(key);
}

/**
 * What the classifier ACTUALLY consumes: the owner answers and the
 * scanner settings, composed by the caller from the two documents they
 * now live in. The classifier has always needed both (a suppressive
 * decision needs an owner answer AND the scan scope that makes it
 * provable), and it still gets exactly one object — so nothing in the
 * lattice learned that the two documents were split.
 */
export type ClassifierPolicy = ClassificationPolicy & ScanConfig;