/**
 * Minimal v1 environment attestation (GF-10, GF-13; ADR 0002, plan
 * invariant 5, docs/research/environment_attestation.md L0/L1 spirit).
 *
 * Two positive checks, both fail-closed:
 *
 * 1. Loopback-only targets (GF-10): the attestation subject (the SUT the
 *    UI drives) and every adapter read base MUST be a loopback address.
 *    A non-loopback target blocks the run BEFORE any adapter read is
 *    constructed — the witness never builds a request against an
 *    unattested base.
 * 2. Env-fingerprint marker (GF-13, minimal v1 attestation): every
 *    adapter base must answer GET `/` with an
 *    `x-gateforge-env-fingerprint` header equal to the adapter's
 *    declared `environmentFingerprint`; when the run also pins
 *    `targetFingerprint`, the adapter must read the SAME environment
 *    the UI drives (adapter fingerprint === run fingerprint). Absent or
 *    mismatched markers reject the record — never `satisfied`.
 *
 * L2 signed statements are deferred per ADR 0002 ("L2 signing deferred").
 */
import { lookup } from 'node:dns/promises';
import { ATTESTATION_SCOPE_HEADER, ENV_FINGERPRINT_HEADER, LOOPBACK_HOSTS } from '../constants.js';
import { clearPinnedLoopbackForTests, pinLoopbackIps, pinnedGet, } from './loopback-pins.js';
/** Default DNS lookup: the OS resolver, all records. */
const defaultLookup = (host) => lookup(host, { all: true, verbatim: true });
/** One failed attestation, carrying the actionable diagnostic. */
export class AttestationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AttestationError';
    }
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
export function isLoopbackUrl(baseUrl) {
    let parsed;
    try {
        parsed = new URL(baseUrl);
    }
    catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return false;
    const host = parsed.hostname;
    if (LOOPBACK_HOSTS[host])
        return true;
    if (/^127(\.\d{1,3}){3}$/.test(host))
        return true;
    if (host === '0.0.0.0')
        return true;
    return false;
}
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
export async function assertLoopback(baseUrl, what) {
    if (!(await isLoopbackUrlResolving(baseUrl))) {
        throw new AttestationError(`${what} base '${baseUrl}' is not loopback; gateforge only attests disposable ` +
            'loopback environments (plan invariant 5, GF-10). A bare URL with no provider ' +
            'contract is not a mutation target.');
    }
}
/** Clears the pin store (tests only — production paths pin once and bind). */
export function clearLoopbackCacheForTests() {
    clearPinnedLoopbackForTests();
}
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
export async function isLoopbackUrlResolving(baseUrl, lookupFn = defaultLookup) {
    if (isLoopbackUrl(baseUrl))
        return true;
    let host;
    try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            return false;
        host = parsed.hostname;
    }
    catch {
        return false;
    }
    try {
        await pinLoopbackIps(host, lookupFn);
        return true;
    }
    catch {
        return false;
    }
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
export async function probeEnvFingerprint(baseUrl, timeoutMs) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            // Pinned egress: attested hostnames connect to their
            // startup-approved loopback IPs (Host preserved); unpinned names
            // behave exactly as before.
            const response = await pinnedGet(baseUrl, {
                timeoutMs,
                signal: controller.signal,
            });
            return {
                fingerprint: response.headers.get(ENV_FINGERPRINT_HEADER),
                scope: response.headers.get(ATTESTATION_SCOPE_HEADER),
            };
        }
        finally {
            clearTimeout(timer);
        }
    }
    catch {
        return { fingerprint: null, scope: null };
    }
}
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
export function envFingerprintMismatch(probe, adapterFingerprint, targetFingerprint) {
    if (probe.fingerprint === null) {
        return `adapter target presents no '${ENV_FINGERPRINT_HEADER}' marker; ` +
            'the environment is not attested (GF-13)';
    }
    if (probe.fingerprint !== adapterFingerprint) {
        return `adapter target fingerprint '${probe.fingerprint}' does not match the adapter's ` +
            `declared environmentFingerprint '${adapterFingerprint}' (GF-13)`;
    }
    if (targetFingerprint !== null && probe.fingerprint !== targetFingerprint) {
        return `adapter target fingerprint '${probe.fingerprint}' differs from the run's attested ` +
            `target fingerprint '${targetFingerprint}': the adapter would read a different ` +
            'environment than the UI under test (GF-13)';
    }
    return null;
}
//# sourceMappingURL=env-attestation.js.map