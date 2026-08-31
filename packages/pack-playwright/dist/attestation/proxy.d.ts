/**
 * Loopback attestation proxy (GF-13 minimal v1, plan invariant 5).
 *
 * A bare disposable app can't positively prove it is disposable. The
 * proxy fronts a loopback app and stamps EVERY response with the
 * environment markers the witness requires:
 *
 * - `x-gateforge-env-fingerprint: <fingerprint>` — the run's attested
 *   environment identity (the witness compares adapter reads against
 *   it; GF-13).
 * - `x-gateforge-attestation-scope: loopback` — the scope the marker
 *   attests (observability; the witness's identity check is the marker).
 *
 * This mirrors the Ryuk label pattern (docs/research/environment_
 * attestation.md §3.1): the signal is created by the same actor that
 * later relies on it — the gateforge runner stamps the environment it
 * created. For real deployments the SUT itself (or its middleware/
 * container labels) presents the same marker.
 */
import { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
/** Handle for a running attestation proxy. */
export interface AttestationProxyHandle {
    /** The proxy's loopback base URL (use this as app/adapter base). */
    url: string;
    stop: () => Promise<void>;
}
/**
 * Starts the attestation proxy in front of `targetBaseUrl`.
 *
 * Args:
 *   targetBaseUrl: absolute URL of the loopback app to front.
 *   fingerprint: marker value to stamp on every response.
 *   scope: attestation-scope marker (default 'loopback').
 *
 * Returns:
 *   AttestationProxyHandle: {url, stop} once listening.
 */
export declare function startAttestationProxy(targetBaseUrl: string, fingerprint: string, scope?: string): Promise<AttestationProxyHandle>;
export type { Server, IncomingMessage, ServerResponse };
//# sourceMappingURL=proxy.d.ts.map