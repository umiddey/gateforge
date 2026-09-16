/** DNS lookup signature (injectable for tests; default: OS resolver). */
export type PinDnsLookup = (host: string) => Promise<ReadonlyArray<{
    address: string;
    family: number;
}>>;
/** Whether one address is loopback (127.0.0.0/8 or ::1). */
export declare function isLoopbackAddress(address: string): boolean;
/** Clears all pins (tests only — production paths pin once and bind). */
export declare function clearPinnedLoopbackForTests(): void;
/**
 * Resolves a hostname and pins ALL-loopback addresses, or rejects.
 * The first successful pinning wins for the process lifetime: later
 * resolutions (including hostile mid-run DNS changes) never replace
 * it — connections bind to the startup-approved set.
 *
 * Args:
 *   hostname: the operator-provided hostname to attest.
 *   lookupFn: DNS lookup (default: OS resolver, all records).
 *
 * Returns:
 *   The pinned loopback IP list (IPv4 first, then IPv6, stable order).
 *
 * Throws:
 *   Error: on empty/mixed/public/unresolvable answers.
 */
export declare function pinLoopbackIps(hostname: string, lookupFn?: PinDnsLookup): Promise<string[]>;
/**
 * Snapshot copy of current pins (hostname → approved IPs).
 *
 * Returns:
 *   A detached copy for launch-arg construction.
 */
export declare function pinnedLoopbackIps(): Map<string, string[]>;
/**
 * Builds the Chromium `--host-resolver-rules` value binding every
 * pinned hostname to its approved IPs (`MAP host ip`, comma-separated,
 * deterministic order). IP literals are emitted bare (brackets are URL
 * syntax and would break rule parsing).
 *
 * Args:
 *   pins: hostname → approved IPs (default: live snapshot).
 *
 * Returns:
 *   The rules string, or null when nothing is pinned (no flag then).
 */
export declare function hostResolverRules(pins?: ReadonlyMap<string, readonly string[]>): string | null;
/** Pinned GET result (fetch-compatible subset used by adapter/probe reads). */
export interface PinnedGetResult {
    status: number;
    headers: Headers;
    json(): Promise<unknown>;
    text(): Promise<string>;
}
/**
 * GET through the startup pins: when the URL's hostname is pinned, the
 * TCP connection goes to the pinned IP while the original Host header
 * (host + non-default port) and path are preserved — tenant routing
 * intact, destination bound. Unpinned hostnames use plain global fetch
 * (previous behavior, unchanged).
 *
 * Args:
 *   url: absolute http(s) URL.
 *   options: timeout, headers, abort signal, redirect budget.
 *
 * Returns:
 *   Status + headers + body readers.
 *
 * Throws:
 *   Error: on transport failure, redirect overflow, or (https) the
 *   pinned IP failing certificate verification — fail closed, never
 *   plaintext fallback.
 */
export declare function pinnedGet(url: string, options: {
    timeoutMs: number;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    maxRedirects?: number;
}): Promise<PinnedGetResult>;
//# sourceMappingURL=loopback-pins.d.ts.map