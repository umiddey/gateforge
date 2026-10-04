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
import {
  clearPinnedLoopbackForTests,
  pinLoopbackIps,
  pinnedGet,
  type PinDnsLookup,
} from './loopback-pins.js';

/** Default DNS lookup: the OS resolver, all records. */
const defaultLookup: PinDnsLookup = (host) => lookup(host, { all: true, verbatim: true });

/** One failed attestation, carrying the actionable diagnostic. */
export class AttestationError extends Error {
  constructor(message: string) {
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
export function isLoopbackUrl(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  if (LOOPBACK_HOSTS[host]) return true;
  if (/^127(\.\d{1,3}){3}$/.test(host)) return true;
  if (host === '0.0.0.0') return true;
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
export async function assertLoopback(baseUrl: string, what: string): Promise<void> {
  if (!(await isLoopbackUrlResolving(baseUrl))) {
    throw new AttestationError(
      `${what} base '${baseUrl}' is not loopback; gateforge only attests disposable ` +
        'loopback environments (plan invariant 5, GF-10). A bare URL with no provider ' +
        'contract is not a mutation target.',
    );
  }
}

/** Signature of the DNS lookup injected for tests (defaults to the OS resolver). */
export type DnsLookup = PinDnsLookup;

/** Clears the pin store (tests only — production paths pin once and bind). */
export function clearLoopbackCacheForTests(): void {
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
export async function isLoopbackUrlResolving(
  baseUrl: string,
  lookupFn: DnsLookup = defaultLookup,
): Promise<boolean> {
  if (isLoopbackUrl(baseUrl)) return true;
  let host: string;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    host = parsed.hostname;
  } catch {
    return false;
  }
  try {
    await pinLoopbackIps(host, lookupFn);
    return true;
  } catch {
    return false;
  }
}

/** The observed fingerprint + attestation scope of one target probe. */
export interface EnvProbe {
  /** Fingerprint marker value, or null when the target presents none. */
  fingerprint: string | null;
  /** Attestation-scope marker value, or null. */
  scope: string | null;
  /**
   * Transport failure as a short diagnostic (the error's
   * `code` when it carries one — e.g. `ECONNREFUSED` — else the
   * wrapped `cause`'s code/message, else the message itself),
   * or null when the target answered. A probe with a transport
   * error presents no markers BY CONSTRUCTION — the target never
   * answered — so the mismatch rule reports unreachability,
   * never a missing marker (R1-19).
   */
  transportError?: string | null;
}

/**
 * Probes a target's env fingerprint: GET the base and read the marker
 * header. A transport failure (DNS, refused connection, timeout)
 * probes as `{fingerprint: null, scope: null, transportError:
 * <diagnostic>}` — the mismatch rule then says the target is
 * UNREACHABLE, never that the marker is missing. Absence of the
 * marker on a REACHED target is still a mismatch, never a pass
 * (fail closed).
 *
 * Args:
 *   baseUrl: target base to probe.
 *   timeoutMs: per-request timeout.
 *
 * Returns:
 *   EnvProbe: observed markers (null when absent) + the transport
 *     error (null when the target answered).
 */
export async function probeEnvFingerprint(
  baseUrl: string,
  timeoutMs: number,
): Promise<EnvProbe> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Pinned egress: attested hostnames connect to their
      // startup-approved loopback IPs (Host preserved); unpinned
      // names behave exactly as before.
      const response = await pinnedGet(baseUrl, {
        timeoutMs,
        signal: controller.signal,
      });
      return {
        fingerprint: response.headers.get(ENV_FINGERPRINT_HEADER),
        scope: response.headers.get(ATTESTATION_SCOPE_HEADER),
        transportError: null,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      fingerprint: null,
      scope: null,
      transportError: describeTransportError(error),
    };
  }
}

/**
 * One transport failure as a short diagnostic: the error's
 * `code` when it carries one (e.g. `ECONNREFUSED`), else the
 * code/message of the error it wraps in `cause` (fetch wraps
 * the underlying transport error), else the message itself.
 */
function describeTransportError(error: unknown): string {
  const coded = (candidate: unknown): string | null => {
    if (typeof candidate !== 'object' || candidate === null) return null;
    const record = candidate as { code?: unknown; message?: unknown };
    if (typeof record.code === 'string' && record.code.length > 0) {
      return typeof record.message === 'string' && record.message.length > 0
        ? `${record.code}: ${record.message}`
        : record.code;
    }
    return null;
  };
  const messageOf = (candidate: unknown): string | null => {
    if (typeof candidate !== 'object' || candidate === null) return null;
    const message = (candidate as { message?: unknown }).message;
    return typeof message === 'string' && message.length > 0 ? message : null;
  };
  const cause =
    typeof error === 'object' && error !== null
      ? (error as { cause?: unknown }).cause
      : undefined;
  return (
    coded(error) ??
    coded(cause) ??
    messageOf(error) ??
    messageOf(cause) ??
    String(error)
  );
}

/**
 * The same-environment rule for one adapter read (GF-13). The adapter
 * base must present a marker EQUAL to the adapter's declared
 * environmentFingerprint, and (when the run pins one) that fingerprint
 * must equal the run's target fingerprint — the adapter may not read a
 * different environment than the UI under test. A target that never
 * answered is unreachable (its transport error is reported), never
 * marker-less (R1-19).
 *
 * Args:
 *   probe: observed markers at the adapter base.
 *   adapterFingerprint: the adapter's declared environmentFingerprint.
 *   targetFingerprint: the run's pinned fingerprint, or null when unset.
 *   baseUrl: the probed adapter base, named in the diagnostics.
 *
 * Returns:
 *   string | null: mismatch description, or null when attested.
 */
export function envFingerprintMismatch(
  probe: EnvProbe,
  adapterFingerprint: string,
  targetFingerprint: string | null,
  baseUrl: string,
): string | null {
  if (probe.transportError !== undefined && probe.transportError !== null) {
    return `target ${baseUrl} is not reachable (${probe.transportError}); ` +
      'start the app before the run (runtime.yml healthcheck)';
  }
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