/**
 * Timing chaos (E63): a SEEDED release plan for the
 * observation proxy's proxied app responses.
 *
 * A real product race — an older list response landing after a newer
 * one, so the UI showed the wrong tab's rows — is found by luck on a
 * loaded machine, and never at all on a fast one. The proxy already
 * sits on the request path of every witnessed test, so it can make the
 * timing uneven ON PURPOSE instead of waiting for luck:
 *
 * - DELAY: the k-th response on a route key waits a seeded
 *   pseudo-random number of milliseconds in [0, maxDelayMs];
 * - REORDER: for requests that share a route key inside one test
 *   session, the seeded plan may release a LATER response before an
 *   earlier one.
 *
 * Only timing changes. Bytes, status, headers and evidence semantics
 * are untouched, and the plan is a pure function of (seed, session
 * identity, route key, k) — never of wall time and never of global
 * arrival order — so one seed reproduces one schedule exactly. That is
 * what makes a chaos finding replayable instead of a ghost.
 *
 * The route key is method + pathname with the query stripped: no query
 * value, request body, header or credential can ever reach the
 * recorded schedule.
 */

/** The tuned chaos bounds a run resolved (the seed is the switch). */
export interface ChaosOptions {
  /** Non-negative integer seed (`--chaos <seed>`). */
  seed: number;
  /** Upper bound of every applied delay, in whole milliseconds. */
  maxDelayMs: number;
  /** Whether a later response may be released before an earlier one. */
  reorder: boolean;
}

/** One recorded release decision (the replayable schedule). */
export interface ChaosScheduleEntry {
  /**
   * The session the plan released under: the supervisor-issued test id
   * (a logical test key, never a credential). It is what makes a
   * schedule reproducible — the same seed, session, route key and k
   * always yield the same delay.
   */
  session: string;
  /** `METHOD /pathname` — never a query value, body or header. */
  routeKey: string;
  /** 1-based index of this request under its route key. */
  k: number;
  /**
   * The PLANNED release offset, in milliseconds from the route's base
   * instant. This is the half of the record that is a pure function of
   * (seed, session, route key, k): two runs of the same seed plan the
   * same offsets, which is what makes a finding replayable.
   */
  plannedDelayMs: number;
  /**
   * Milliseconds this response was actually held back. It can be
   * smaller than the plan when a concurrent request arrived late: the
   * plan never holds a response past its own arrival.
   */
  delayMs: number;
  /** True when the plan released this response before the previous one. */
  releasedBefore: boolean;
}

/** The largest accepted `maxDelayMs` (a chaos run is a finding tool). */
export const MAX_DELAY_CEILING_MS = 5_000;

/** The documented default bound when the owner configures none. */
const DEFAULT_MAX_DELAY_MS = 400;


/** A reserved release slot, held from request arrival to response release. */
export interface ChaosSlot {
  /** `METHOD /pathname` the slot belongs to (query already stripped). */
  routeKey: string;
  /** 1-based index under that route key. */
  k: number;
  /** The planned release offset, in milliseconds from the route's base. */
  delayMs: number;
  /** The instant this request arrived at the proxy. */
  arrivedAt: number;
  /** Monotonic instant the response may be released. */
  releaseAt: number;
  /** True when the plan releases this one before the previous one. */
  releasedBefore: boolean;
}

/**
 * mulberry32: the whole seeded generator. Small, dependency-free and
 * deterministic — the same 32-bit state always yields the same stream,
 * in every process and every platform.
 *
 * Args:
 *   state: the 32-bit stream state.
 *
 * Returns:
 *   () => number: the next value in [0, 1).
 */
function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Folds the seed and the identity parts into one 32-bit stream state
 * (FNV-1a over the parts, then a final avalanche). The parts are the
 * session identity, the route key and the request index — everything a
 * delay may depend on, and nothing else.
 */
function streamOf(seed: number, parts: readonly (string | number)[]): () => number {
  let hash = (seed ^ 0x9e3779b9) >>> 0;
  for (const part of parts) {
    const text = String(part);
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash ^ text.charCodeAt(index)) >>> 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash = (hash ^ (hash >>> 13)) >>> 0;
  }
  return mulberry32(hash);
}

/**
 * Parses the chaos environment a supervised run handed the witness.
 *
 * Args:
 *   env: the three chaos environment values (any may be absent).
 *
 * Returns:
 *   ChaosOptions: the resolved bounds, or null when no seed was
 *   configured — the byte-identical no-chaos path.
 *
 * @throws Error: fail-closed on a seed that is not a non-negative
 *   integer, a bound that is not a whole number of milliseconds, or a
 *   reorder flag that is neither on nor off. A silently misread seed
 *   would produce a schedule the owner cannot name or replay.
 */
export function parseChaosOptions(env: {
  seed: string | undefined;
  maxDelayMs: string | undefined;
  reorder: string | undefined;
}): ChaosOptions | null {
  // Absent means off; present-but-empty is a mistake worth failing on
  // (a silent "no chaos" for a run the owner asked to perturb is the
  // one outcome that would make a finding unreproducible).
  if (env.seed === undefined) return null;
  const seedText = env.seed;
  if (!/^\d+$/.test(seedText)) {
    throw new Error(
      `invalid chaos seed '${seedText}': --chaos takes a non-negative integer seed (0, 1, 2, ...)`,
    );
  }
  const maxDelayMs = parseBound(env.maxDelayMs);
  const reorder = parseReorder(env.reorder);
  return { seed: Number(seedText), maxDelayMs, reorder };
}

/**
 * Resolves `maxDelayMs` against the default and the hard ceiling.
 *
 * Args:
 *   raw: the configured bound, or undefined for the default.
 *
 * Returns:
 *   number: the accepted bound in whole milliseconds.
 *
 * @throws Error: on anything but a whole number within the ceiling.
 */
function parseBound(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_DELAY_MS;
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_DELAY_CEILING_MS) {
    throw new Error(
      `invalid chaos max delay '${raw}': it must be a whole number of milliseconds between 0 and ${String(
        MAX_DELAY_CEILING_MS,
      )}`,
    );
  }
  return Number(raw);
}

/**
 * Resolves the `on`/`off` reorder flag (default: on).
 *
 * Args:
 *   raw: the configured flag, or undefined for the default.
 *
 * Returns:
 *   boolean: whether reordering is permitted.
 *
 * @throws Error: on any value that is not on or off.
 */
function parseReorder(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  if (raw === 'on' || raw === 'true') return true;
  if (raw === 'off' || raw === 'false') return false;
  throw new Error(`invalid chaos reorder '${raw}': it must be 'on' or 'off'`);
}

/** Per-route-key release cursor: the plan never reads wall time. */
interface RouteCursor {
  /** Instant the first request on this route key arrived. */
  baseAt: number;
  /** Planned offset of the previous request (monotonic for order). */
  plannedMs: number;
  /** Requests planned so far under this route key. */
  k: number;
}

/**
 * Builds the route key of a proxied request: `METHOD /pathname`, with
 * the query and fragment stripped.
 *
 * The strip is the secret guarantee, so it lives here and runs on every
 * reservation: a route key that kept `?token=…` would write a
 * credential into a report the owner pastes into a bug.
 *
 * Args:
 *   method: the request method (any case).
 *   url: the request target as it arrived (path plus query).
 *
 * Returns:
 *   string: the `METHOD /pathname` route key.
 */
export function chaosRouteKey(method: string, url: string): string {
  const target = url.startsWith('/') ? url : `/${url}`;
  const cut = target.search(/[?#]/);
  return `${method.toUpperCase()} ${cut === -1 ? target : target.slice(0, cut)}`;
}

/**
 * One session's chaos plan. A session owns its own scheduler, so the
 * per-route `k` and the recorded schedule are the session's — two tests
 * in one run can never shift each other's timing.
 */
export class ChaosScheduler {
  /** The tuned bounds this plan releases under. */
  private readonly options: ChaosOptions;

  /** Stable session identity (the supervisor-issued test id). */
  private readonly session: string;

  /** Per-route-key release cursors. */
  private readonly cursors = new Map<string, RouteCursor>();

  /**
   * Args:
   *   options: the resolved bounds for this run.
   *   session: the session identity (stable across replays — the
   *     random session uuid would make a schedule unreplayable).
   */
  constructor(options: ChaosOptions, session: string) {
    this.options = options;
    this.session = session;
  }

  /**
   * Reserves the release slot for one proxied request, at arrival.
   *
   * The k-th request under a route key is planned as follows: its own
   * seeded delay, then either held strictly after the previous
   * request's planned release (natural order) or — when the seeded
   * reorder bit says so — pulled strictly before it. Offsets are
   * measured from the FIRST request on the route key, so a later
   * arrival that is still concurrent with the first can genuinely be
   * released ahead of it.
   *
   * Args:
   *   routeKeyInput: `METHOD /pathname`; a raw request target is
     * accepted too and stripped to its pathname.
   *   now: monotonic arrival instant.
   *
   * Returns:
   *   ChaosSlot: the reserved release slot.
   */
  reserve(routeKeyInput: string, now: number): ChaosSlot {
    // Defensive strip: a caller that hands over a raw request target
    // still cannot get a query value into the recorded schedule.
    const cut = routeKeyInput.search(/[?#]/);
    const routeKey = cut === -1 ? routeKeyInput : routeKeyInput.slice(0, cut);
    const cursor = this.cursors.get(routeKey);
    const k = cursor === undefined ? 1 : cursor.k + 1;
    const baseAt = cursor?.baseAt ?? now;
    const previous = cursor?.plannedMs ?? -1;
    const seeded = this.seededDelayMs(routeKey, k);
    const plannedMs =
      k === 1
        ? seeded
        : this.options.reorder && this.seededReorder(routeKey, k)
          ? Math.max(0, Math.min(seeded, previous - 1))
          : Math.max(seeded, previous + 1);
    this.cursors.set(routeKey, { baseAt, plannedMs, k });
    return {
      routeKey,
      k,
      delayMs: plannedMs,
      arrivedAt: now,
      releaseAt: baseAt + plannedMs,
      // Strictly before: a plan that could not open a gap (both at
      // zero) never claims a reorder it did not perform.
      releasedBefore: k > 1 && plannedMs < previous,
    };
  }

  /**
   * Resolves the applied delay for a reserved slot and returns the
   * release decision to record. A response that already waited longer
   * than its slot (a slow upstream) is released immediately: the plan
   * holds a response back, it never extends one.
   *
   * Args:
   *   slot: the slot returned by {@link ChaosScheduler.reserve}.
   *   held: whether the response was actually held for its slot. A
   *     response whose upstream overran the slot before the proxy could
   *     hold it is recorded with no delay - the plan extends nothing.
   *
   * Returns:
   *   ChaosScheduleEntry: the recorded decision (route key, k, applied
   *   delay, reorder flag) - the replay record.
   */
  release(slot: ChaosSlot, held: boolean): ChaosScheduleEntry {
    return {
      session: this.session,
      routeKey: slot.routeKey,
      k: slot.k,
      plannedDelayMs: slot.delayMs,
      // Measured from ARRIVAL: that is the hold the client actually
      // felt, and it is the number an owner reads to understand a
      // schedule. Measuring from the release moment would report ~0 for
      // every entry and explain nothing.
      // A request that arrives after the route's base instant can have
      // a deadline in its own past: the proxy then holds it not at all,
      // and the record says so rather than reporting a negative hold.
      delayMs: held
        ? Math.max(0, Math.min(slot.releaseAt - slot.arrivedAt, this.options.maxDelayMs))
        : 0,
      releasedBefore: slot.releasedBefore,
    };
  }

  /** The seeded delay of the k-th request under a route key, in ms. */
  private seededDelayMs(routeKey: string, k: number): number {
    const next = streamOf(this.options.seed, [this.session, routeKey, k, 'delay'])();
    return Math.min(this.options.maxDelayMs, Math.floor(next * (this.options.maxDelayMs + 1)));
  }

  /** The seeded reorder decision of the k-th request under a route key. */
  private seededReorder(routeKey: string, k: number): boolean {
    return streamOf(this.options.seed, [this.session, routeKey, k, 'reorder'])() < 0.5;
  }
}
