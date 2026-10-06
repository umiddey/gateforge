/**
 * CDP app-data settlement tracker for the page-proof channels (currently
 * wired into the engine's swept visits; built to be shared verbatim with
 * the browser tests' observed channel).
 *
 * Chromium finishes a fetch's network load (CDP `Network.loadingFinished`)
 * only once the browser considers the exchange done, which on real apps can
 * lag behind "headers + every byte arrived" while the page never touches the
 * body (`if (!res.ok) return null`). This tracker replaces the Playwright
 * request/response/requestfinished/requestfailed tracking with the browser's
 * own network events, keyed by CDP requestId, and settles one tracked
 * exchange when EITHER:
 *
 *   (a) `Network.loadingFinished` arrives, OR
 *   (b) response headers declared a `Content-Length` N and the bytes
 *       received for the exchange reach N — `dataReceived.encodedDataLength`
 *       when the response carries a non-identity `content-encoding` (the
 *       declared length is the wire size), else `dataReceived.dataLength`
 *       (decoded == wire for identity).
 *
 * A declared length of 0 settles at the headers. An unread body without a
 * declared length (chunked or connection-delimited) that the browser never
 * finishes stays outstanding — conservative: unverifiable data never proves
 * a page. Bytes short of the declared length at grading time leave the
 * exchange outstanding; a dead body (`Network.loadingFailed`, e.g.
 * `net::ERR_CONTENT_LENGTH_MISMATCH`) is a failure exactly as before.
 * Redirect hops never complete by bytes: a mid-chain hop's full body says
 * nothing about the chain's final response, so a redirected exchange
 * settles only via (a) or failure. `net::ERR_ABORTED` cancels keep their
 * superseded-retry excuse in the shared grader (unchanged).
 *
 * TYPE-ONLY: no Playwright import at runtime — the CDP session is opened
 * structurally on the page the channel already holds.
 */
import type { CDPSession, Page } from 'playwright';

/** One CDP-tracked app data exchange on one page. */
export interface TrackedApiExchange {
  /** CDP network request id (stable across the exchange's redirect hops). */
  readonly requestId: string;
  /** Uppercase method of the exchange's current hop. */
  method: string;
  /** Full URL of the exchange's current hop. */
  url: string;
}

/** Response headers of one tracked exchange hop, collected at arrival. */
export interface TrackedApiResponseHeaders {
  /** Full response URL (the hop's URL). */
  url: string;
  /** Response status the app answered. */
  status: number;
  /** Remote peer address; null when none was reported (e.g. local fulfill). */
  remoteAddress: string | null;
}

/** How one tracked exchange left the browser's network stack. */
export type TrackedApiSettlement =
  | { kind: 'completed' }
  | { kind: 'failed'; errorText: string; canceled: boolean };

/** Channel hooks the tracker calls on the browser's network events. */
export interface ApiSettlementHost {
  /** The app-origin/resource-type filter (the channels' existing rule). */
  isAppDataExchange(url: URL, resourceType: string): boolean;
  /** A tracked exchange started (the channel attributes it to its window). */
  onExchangeOpen(exchange: TrackedApiExchange): void;
  /** Response headers arrived; every redirect hop is reported separately. */
  onExchangeHeaders(exchange: TrackedApiExchange, headers: TrackedApiResponseHeaders): void;
  /** The exchange completed or failed; never called twice for one exchange. */
  onExchangeSettled(exchange: TrackedApiExchange, settlement: TrackedApiSettlement): void;
  /** Raw network activity; wakes the channels' bounded drain waits. */
  onActivity(): void;
}

/** One live CDP network session tracking one page; detach when done. */
export interface ApiSettlementTracker {
  detach(): Promise<void>;
}

/** CDP resource types that carry application data exchanges (mapped). */
const CDP_API_RESOURCE_TYPES: Record<string, string> = { Fetch: 'fetch', XHR: 'xhr' };

interface ExchangeRecord extends TrackedApiExchange {
  /** Content-Length the current hop declared; null when none or unknown. */
  declaredLength: number | null;
  /** True when the current hop travels with a non-identity content coding. */
  compressed: boolean;
  /** Bytes received for the current hop (wire or decoded, per compressed). */
  receivedBytes: number;
  /** True once a redirectResponse was seen; bytes may no longer complete. */
  redirected: boolean;
  settled: boolean;
}

/**
 * Tracks the app data exchanges of one page over its own CDP network
 * session (`page.context().newCDPSession(page)` + `Network.enable`).
 * Opening the session fails loud: a channel that cannot observe the
 * browser's network events must never grade pages as settled.
 */
export async function trackPageApiSettlement(page: Page, host: ApiSettlementHost): Promise<ApiSettlementTracker> {
  const session: CDPSession = await page.context().newCDPSession(page);
  const exchanges = new Map<string, ExchangeRecord>();
  const settle = (record: ExchangeRecord, settlement: TrackedApiSettlement): void => {
    if (record.settled) return;
    record.settled = true;
    exchanges.delete(record.requestId);
    host.onExchangeSettled(record, settlement);
  };
  const complete = (record: ExchangeRecord): void => settle(record, { kind: 'completed' });
  const fail = (record: ExchangeRecord, errorText: string, canceled: boolean): void =>
    settle(record, { kind: 'failed', errorText, canceled });
  session.on('Network.requestWillBeSent', (params) => {
    if (params.redirectResponse !== undefined) {
      const record = exchanges.get(params.requestId);
      if (record !== undefined) {
        // The completed hop: report its headers, then keep the exchange
        // outstanding for the next hop (bytes may no longer complete it).
        record.redirected = true;
        record.declaredLength = null;
        record.receivedBytes = 0;
        host.onActivity();
        host.onExchangeHeaders(record, {
          url: params.redirectResponse.url,
          status: params.redirectResponse.status,
          remoteAddress: params.redirectResponse.remoteIPAddress ?? null,
        });
      }
    }
    let url: URL;
    try { url = new URL(params.request.url); } catch { return; }
    const resourceType = CDP_API_RESOURCE_TYPES[params.type ?? ''] ?? params.type ?? '';
    if (!host.isAppDataExchange(url, resourceType)) return;
    const existing = exchanges.get(params.requestId);
    if (existing !== undefined) {
      // Redirect hop of an already-tracked exchange: attribution (and the
      // record identity) stay with the exchange; only the current hop's
      // method/URL move forward.
      existing.method = params.request.method;
      existing.url = params.request.url;
      return;
    }
    const record: ExchangeRecord = {
      requestId: params.requestId,
      method: params.request.method,
      url: params.request.url,
      declaredLength: null,
      compressed: false,
      receivedBytes: 0,
      redirected: false,
      settled: false,
    };
    exchanges.set(params.requestId, record);
    host.onExchangeOpen(record);
    host.onActivity();
  });
  session.on('Network.responseReceived', (params) => {
    const record = exchanges.get(params.requestId);
    if (record === undefined) return;
    host.onActivity();
    record.declaredLength = declaredContentLength(params.response.headers);
    record.compressed = hasNonIdentityEncoding(params.response.headers);
    record.receivedBytes = 0;
    host.onExchangeHeaders(record, {
      url: params.response.url,
      status: params.response.status,
      remoteAddress: params.response.remoteIPAddress ?? null,
    });
    if (!record.redirected && record.declaredLength === 0) complete(record);
  });
  session.on('Network.dataReceived', (params) => {
    const record = exchanges.get(params.requestId);
    if (record === undefined) return;
    host.onActivity();
    if (record.settled || record.redirected || record.declaredLength === null) return;
    record.receivedBytes += record.compressed ? params.encodedDataLength : params.dataLength;
    if (record.receivedBytes >= record.declaredLength) complete(record);
  });
  session.on('Network.loadingFinished', (params) => {
    const record = exchanges.get(params.requestId);
    if (record === undefined) return;
    host.onActivity();
    complete(record);
  });
  session.on('Network.loadingFailed', (params) => {
    const record = exchanges.get(params.requestId);
    if (record === undefined) return;
    host.onActivity();
    fail(record, params.errorText, params.canceled === true);
  });
  await session.send('Network.enable', {});
  return {
    async detach(): Promise<void> {
      // Teardown must never mask the channel's own error (a page or browser
      // that died first has no session left to detach).
      try {
        await session.detach();
      } catch {}
    },
  };
}

/** Case-insensitive Content-Length of a CDP header bag; null when absent. */
function declaredContentLength(headers: Record<string, string>): number | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-length') continue;
    const length = Number(value);
    return Number.isFinite(length) && length >= 0 ? length : null;
  }
  return null;
}

/** True when the response body travels with a non-identity content coding. */
function hasNonIdentityEncoding(headers: Record<string, string>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-encoding') continue;
    return value
      .split(',')
      .some((coding) => {
        const normalized = coding.trim().toLowerCase();
        return normalized !== '' && normalized !== 'identity';
      });
  }
  return false;
}
