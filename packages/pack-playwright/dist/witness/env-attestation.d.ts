import { type PinDnsLookup } from './loopback-pins.js';
/** One failed attestation, carrying the actionable diagnostic. */
export declare class AttestationError extends Error {
    constructor(message: string);
}
/**
 * Whether a base URL is loopback. Accepts the standard loopback
 * hostnames/IPs (localhost, 127.0.0.0/8, ::1).
 *
 * Args:
 *   baseUrl: absolute http(s) URL.
 *
 * Returns:
 *   boolean: true when the host is a recognized loopback host.
 */
export declare function isLoopbackUrl(baseUrl: string): boolean;
/**
 * Asserts the attestation subject is loopback (GF-10). Called at witness
 * startup for the target and before EVERY adapter read for the read
 * base. Hostnames that are not literally loopback are resolved through
 * the OS resolver (hosts file + DNS): a name whose addresses are ALL
 * loopback (127.0.0.0/8, ::1) is loopback by construction — the
 * disposable-stack pattern of tenant subdomains mapped to 127.0.0.1.
 * Mixed records, unresolvable names, and lookup failures all reject
 * (fail closed). Approved addresses are PINNED per hostname for the
 * process lifetime (see `loopback-pins.ts`): later DNS changes never
 * move established connections — the check validates
 * OPERATOR-provided bases (never suite input — suites cannot set
 * target/adapter bases), and every egress binds to the startup
 * approval.
 *
 * Args:
 *   baseUrl: the base to verify.
 *   what: human label for diagnostics ("attestation subject", "adapter 'x'").
 *
 * Throws:
 *   AttestationError: when the base is not loopback — the run is BLOCKED
 *   before any request is constructed (plan invariant 5).
 */
export declare function assertLoopback(baseUrl: string, what: string): Promise<void>;
/** Signature of the DNS lookup injected for tests (defaults to the OS resolver). */
export type DnsLookup = PinDnsLookup;
/** Clears the pin store (tests only — production paths pin once and bind). */
export declare function clearLoopbackCacheForTests(): void;
/**
 * Whether a base URL is loopback, resolving non-literal hostnames. The
 * sync string check (`isLoopbackUrl`) runs first; only names it rejects
 * reach the resolver, which pins all-loopback answers (see
 * `loopback-pins.ts` — first resolution wins, later DNS changes never
 * replace the pins).
 *
 * Args:
 *   baseUrl: absolute http(s) URL.
 *   lookupFn: DNS lookup (default: OS resolver via `node:dns/promises`).
 *
 * Returns:
 *   Promise<boolean>: true when literally loopback or ALL resolved
 *   addresses are loopback. False on mixed records, unresolvable names,
 *   lookup failures, and non-http(s) URLs.
 */
export declare function isLoopbackUrlResolving(baseUrl: string, lookupFn?: DnsLookup): Promise<boolean>;
/** The observed fingerprint + attestation scope of one target probe. */
export interface EnvProbe {
    /** Fingerprint marker value, or null when the target presents none. */
    fingerprint: string | null;
    /** Attestation-scope marker value, or null. */
    scope: string | null;
}
/**
 * Probes a target's env fingerprint: GET the base and read the marker
 * header. Any transport failure probes as `{fingerprint: null, scope:
 * null}` — absence is a mismatch, never a pass (fail closed).
 *
 * Args:
 *   baseUrl: target base to probe.
 *   timeoutMs: per-request timeout.
 *
 * Returns:
 *   EnvProbe: observed markers (null when absent/unreachable).
 */
export declare function probeEnvFingerprint(baseUrl: string, timeoutMs: number): Promise<EnvProbe>;
/**
 * The same-environment rule for one adapter read (GF-13). The adapter
 * base must present a marker EQUAL to the adapter's declared
 * environmentFingerprint, and (when the run pins one) that fingerprint
 * must equal the run's target fingerprint — the adapter may not read a
 * different environment than the UI under test.
 *
 * Args:
 *   probe: observed markers at the adapter base.
 *   adapterFingerprint: the adapter's declared environmentFingerprint.
 *   targetFingerprint: the run's pinned fingerprint, or null when unset.
 *
 * Returns:
 *   string | null: mismatch description, or null when attested.
 */
export declare function envFingerprintMismatch(probe: EnvProbe, adapterFingerprint: string, targetFingerprint: string | null): string | null;
//# sourceMappingURL=env-attestation.d.ts.map