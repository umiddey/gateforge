/**
 * Declared live channels for page visits (0.13.x): exchanges a page
 * keeps open ON PURPOSE — a controller-declared same-origin path prefix,
 * a WebSocket upgrade on the app host, or a `text/event-stream` response
 * — are never finished app data requests. They must not hold a visit's
 * settle wait and must never grade as app data evidence; each channel
 * lists what it saw so the visit payload stays visible. Declared
 * prefixes are controller-held configuration (`pages.liveChannels`),
 * never names guessed from traffic: an undeclared long poll stays an
 * app data request and still refuses a page as unsettled (fail closed).
 */

/** The live channels one visit observed (listed in the record payload). */
export interface LiveChannelSnapshot {
  /** Distinct live-channel request paths seen. */
  count: number;
  /** Sorted distinct paths (pathname only, no query). */
  paths: string[];
}

/** Hosts (host[:port]) of the controller-declared trusted app origins. */
export function appHostsOfOrigins(origins: readonly string[]): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const origin of origins) {
    try {
      hosts.add(new URL(origin).host);
    } catch {
      // An invalid origin contributes no host (the channels validate
      // origins before this point; stay silent and safe here).
    }
  }
  return hosts;
}

/**
 * The live-channel rules for one page (or one observation window).
 * Create one per visit/window; note every live exchange and snapshot at
 * grading time.
 */
export class LiveChannelTracker {
  private readonly paths = new Set<string>();

  constructor(
    private readonly prefixes: readonly string[],
    private readonly appHosts: ReadonlySet<string>,
  ) {}

  /** A controller-declared prefix match on an app host (same-origin). */
  declaredPrefix(url: URL): boolean {
    return this.appHosts.has(url.host) && this.prefixes.some((prefix) => url.pathname.startsWith(prefix));
  }

  /** A WebSocket upgrade on an app host (protocol fact, host-scoped). */
  appWebSocket(url: URL): boolean {
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && this.appHosts.has(url.host);
  }

  /** URL-only liveness: decidable when the request opens. */
  isLiveByUrl(url: URL): boolean {
    return this.declaredPrefix(url) || this.appWebSocket(url);
  }

  /** Header-time liveness: a server-sent-events response (protocol fact). */
  static isEventStream(contentType: string | null): boolean {
    return contentType !== null && contentType.trim().toLowerCase().startsWith('text/event-stream');
  }

  /** Records one live exchange (deduplicated by pathname). */
  note(url: URL): void {
    this.paths.add(url.pathname);
  }

  /** The listed channels of this visit so far. */
  snapshot(): LiveChannelSnapshot {
    return { count: this.paths.size, paths: [...this.paths].sort() };
  }
}

/** Snapshot helper for channels that track noted paths directly. */
export function liveChannelSnapshot(paths: ReadonlySet<string>): LiveChannelSnapshot {
  return { count: paths.size, paths: [...paths].sort() };
}
