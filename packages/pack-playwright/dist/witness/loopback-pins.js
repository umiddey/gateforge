/**
 * Loopback egress binding (GF-10 follow-up): approving a hostname is not
 * enough — every later connection must STAY on the approved loopback
 * addresses even if resolution changes mid-run (DNS rebinding). This
 * module pins operator-attested hostnames to their startup-resolved
 * loopback IPs and binds all three strict-flow egresses to the pins:
 *
 * - the engine Chromium launches with `--host-resolver-rules` mapping
 *   each attested hostname to its approved IPs (the browser is then
 *   incapable of leaving loopback for those names);
 * - witness adapter/probe reads go through `pinnedGet`, which connects
 *   to the pinned IP while preserving the original Host header (tenant
 *   routing intact) and port; same-hostname redirects are followed on
 *   the Location header's actual port with the matching Host header,
 *   while cross-host and cross-scheme hops reject (never a silent
 *   re-request of a different destination than the one named);
 * - the observation-proxy upstream keeps startup resolve-or-reject only
 *   (that topology is unused by the strict spawned flow; documented).
 *
 * Fail-closed throughout: unresolvable/mixed/public resolutions reject
 * at pin time; https reads against a pinned IP fail on certificate
 * mismatch (no insecure override exists here); unpinned hostnames keep
 * the previous plain-fetch behavior.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
/** Whether one address is loopback (127.0.0.0/8 or ::1). */
export function isLoopbackAddress(address) {
    return address === '::1' || /^127(\.\d{1,3}){3}$/.test(address);
}
/** Hostname → startup-approved loopback IPs (first resolution wins). */
const pinnedIps = new Map();
/** Clears all pins (tests only — production paths pin once and bind). */
export function clearPinnedLoopbackForTests() {
    pinnedIps.clear();
}
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
export async function pinLoopbackIps(hostname, lookupFn = (host) => lookup(host, { all: true, verbatim: true })) {
    const existing = pinnedIps.get(hostname);
    if (existing !== undefined)
        return [...existing];
    let records;
    try {
        records = await lookupFn(hostname);
    }
    catch {
        throw new Error(`hostname '${hostname}' does not resolve to loopback (lookup failed)`);
    }
    if (records.length === 0 || !records.every((record) => isLoopbackAddress(record.address))) {
        throw new Error(`hostname '${hostname}' does not resolve exclusively to loopback`);
    }
    const v4 = records.filter((record) => record.family === 4).map((record) => record.address);
    const v6 = records.filter((record) => record.family !== 4).map((record) => record.address);
    const pinned = [...new Set([...v4, ...v6])];
    pinnedIps.set(hostname, pinned);
    return [...pinned];
}
/**
 * Snapshot copy of current pins (hostname → approved IPs).
 *
 * Returns:
 *   A detached copy for launch-arg construction.
 */
export function pinnedLoopbackIps() {
    return new Map([...pinnedIps].map(([host, ips]) => [host, [...ips]]));
}
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
export function hostResolverRules(pins = pinnedLoopbackIps()) {
    const rules = [];
    for (const host of [...pins.keys()].sort()) {
        for (const ip of pins.get(host) ?? []) {
            rules.push(`MAP ${host} ${ip}`);
        }
    }
    return rules.length > 0 ? rules.join(', ') : null;
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
export async function pinnedGet(url, options) {
    const pins = pinnedLoopbackIps();
    const parsed = new URL(url);
    const pinned = pins.get(parsed.hostname);
    if (pinned === undefined || pinned.length === 0) {
        const response = await fetch(url, {
            method: 'GET',
            headers: { accept: 'application/json, text/html', ...options.headers },
            signal: options.signal,
            redirect: 'follow',
        });
        return {
            status: response.status,
            headers: response.headers,
            json: () => response.json(),
            text: () => response.text(),
        };
    }
    const ip = preferIpv4(pinned);
    const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80';
    const hostHeader = isDefaultPort(parsed.protocol, port) ? parsed.hostname : `${parsed.hostname}:${port}`;
    return requestPinned({
        protocol: parsed.protocol,
        ip,
        port: Number(port),
        path: `${parsed.pathname}${parsed.search}`,
        hostHeader,
        headers: options.headers ?? {},
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        maxRedirects: options.maxRedirects ?? 5,
    });
}
/** Prefers an IPv4 loopback pin, else the first approved IP. */
function preferIpv4(ips) {
    return ips.find((ip) => /^127(\.\d{1,3}){3}$/.test(ip)) ?? ips[0];
}
/** Whether the port is the protocol default (Host header omits it then). */
function isDefaultPort(protocol, port) {
    return (protocol === 'http:' && port === '80') || (protocol === 'https:' && port === '443');
}
async function requestPinned(input) {
    if (input.protocol !== 'http:' && input.protocol !== 'https:') {
        throw new Error(`pinned egress supports http(s) only (got '${input.protocol}')`);
    }
    // eslint-disable-next-line no-await-in-loop -- redirect hops are sequential by construction
    for (let redirect = 0; redirect <= input.maxRedirects; redirect += 1) {
        const response = await singleRequest(input);
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location !== null) {
            const next = new URL(location, `${input.protocol}//${input.hostHeader}${input.path}`);
            // Redirects stay on pinned egress: only same-hostname hops are
            // followed through the pins; anything else fails closed (the
            // browser path enforces the same origin rule in captureExchanges).
            if (next.hostname !== input.hostHeader.split(':')[0]) {
                throw new Error(`pinned egress refuses cross-host redirect to '${next.hostname}'`);
            }
            // Same-host hops follow the Location's ACTUAL origin: protocol,
            // port, and Host header all update, and the connection stays bound
            // to the pinned IP. Re-requesting the previous origin (old port)
            // with the new path — or silently trusting the header while
            // keeping the old transport — would read a different destination
            // than the one the service named. A scheme change is rejected
            // outright: https against the pinned loopback IP can never verify
            // a certificate here, so it fails closed with the precise cause.
            if (next.protocol !== input.protocol) {
                throw new Error(`pinned egress refuses cross-scheme redirect (${input.protocol} → ${next.protocol} '${location}')`);
            }
            const port = next.port !== '' ? next.port : next.protocol === 'https:' ? '443' : '80';
            input = {
                ...input,
                port: Number(port),
                path: `${next.pathname}${next.search}`,
                hostHeader: isDefaultPort(next.protocol, port) ? next.hostname : `${next.hostname}:${port}`,
            };
            continue;
        }
        return response;
    }
    throw new Error('pinned egress exceeded redirect budget');
}
function singleRequest(input) {
    return new Promise((resolve, reject) => {
        const requestFn = input.protocol === 'https:' ? httpsRequest : httpRequest;
        const request = requestFn({
            hostname: input.ip,
            port: input.port,
            path: input.path,
            method: 'GET',
            headers: { accept: 'application/json, text/html', ...input.headers, host: input.hostHeader },
            timeout: input.timeoutMs,
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const body = Buffer.concat(chunks);
                const headers = new Headers();
                for (const [name, value] of Object.entries(response.headersDistinct ?? {})) {
                    const values = Array.isArray(value) ? value : [value ?? ''];
                    for (const item of values)
                        headers.append(name, item);
                }
                resolve({
                    status: response.statusCode ?? 0,
                    headers,
                    json: () => Promise.resolve(JSON.parse(body.toString('utf8'))),
                    text: () => Promise.resolve(body.toString('utf8')),
                });
            });
        });
        request.on('timeout', () => request.destroy(new Error('pinned egress timed out')));
        if (input.signal !== undefined) {
            if (input.signal.aborted)
                request.destroy(new Error('pinned egress aborted'));
            else
                input.signal.addEventListener('abort', () => request.destroy(new Error('pinned egress aborted')), { once: true });
        }
        request.on('error', reject);
        request.end();
    });
}
//# sourceMappingURL=loopback-pins.js.map