/**
 * Owner-disposition time bounds shared by the two disposition shapes:
 * behavior-policy endpoint dispositions (`behavior.yml`) and
 * coverage-policy table dispositions (`.gateforge.yml`
 * `coveragePolicy`).
 *
 * A disposition MAY carry an optional `expiresAt` (ISO-8601, the waiver
 * `expiresAt` convention). Absent = the disposition stands exactly as
 * before this feature existed. Present = it is ENFORCED against the
 * INJECTED run clock (never the wall clock): before the instant the
 * disposition applies as written; at/after it the disposition is VOID —
 * the endpoint/table grades as if it had no disposition — and a blocking
 * `DISPOSITION_EXPIRED` finding names the target, the expiry, and the
 * extend command.
 *
 * A disposition whose `expiresAt` lies further out than the configured
 * maximum (default 30 days, `disposition.maxDays` in `.gateforge.yml`)
 * is a configuration error — the same fail-closed max-duration rule the
 * waiver and quarantine loaders apply. `extensions` records one audit
 * entry per `gateforge disposition extend`.
 */
import { z } from 'zod';

/** One recorded `gateforge disposition extend` audit entry. */
export const DispositionExtensionSchema = z
  .object({
    /** When the extension was recorded (ISO-8601). */
    at: z.iso.datetime(),
    /** Who extended the disposition (`--owner`). */
    by: z.string().min(1),
    /** Why the extension was made (`--reason`). */
    reason: z.string().min(1),
    /** The expiry instant this extension replaced. */
    previousExpiresAt: z.iso.datetime(),
  })
  .strict();

/** Inferred disposition-extension shape. */
export type DispositionExtension = z.infer<typeof DispositionExtensionSchema>;

/** Default maximum disposition lifetime in days (owner decision 2026-10-17). */
export const DISPOSITION_MAX_DAYS = 30;

/** The documented default ceiling in milliseconds. */
export const DISPOSITION_MAX_DURATION_MS = DISPOSITION_MAX_DAYS * 86_400_000;

/** The disposition fields the expiry judgment reads. */
export interface ExpiringDisposition {
  /** Optional expiry instant (ISO-8601). */
  expiresAt?: string;
}

/** Options for {@link dispositionExpiry}: injected clock + max duration. */
export interface DispositionExpiryOptions {
  /** Injected clock instant (Date or ISO-8601) the expiry is judged against. */
  now: Date | string;
  /** Maximum allowed time-until-expiry; defaults to the documented 30 days. */
  maxDurationMs?: number;
}

/**
 * Why a disposition currently does not excuse its endpoint/table.
 * `no-expiry` and `active` are the honoured states; `expired` voids the
 * disposition and blocks; `over-max` is a fail-closed configuration
 * error (mirror of the waiver/quarantine max-duration rule).
 */
export type DispositionExpiry =
  | { state: 'no-expiry' }
  | { state: 'active'; expiresAt: string }
  | { state: 'expired'; expiresAt: string }
  | { state: 'over-max'; expiresAt: string; detail: string };

/**
 * Judges one disposition's optional `expiresAt` against the INJECTED
 * clock — the single shared implementation both policy evaluators use,
 * so behavior and coverage can never disagree about expiry.
 *
 * Args:
 *   disposition: the disposition (its optional `expiresAt` is read).
 *   options: injected clock, optional maximum duration.
 *
 * Returns:
 *   DispositionExpiry: the judged state.
 */
export function dispositionExpiry(
  disposition: ExpiringDisposition,
  options: DispositionExpiryOptions,
): DispositionExpiry {
  if (disposition.expiresAt === undefined) return { state: 'no-expiry' };
  const nowMs =
    options.now instanceof Date
      ? options.now.getTime()
      : (z.iso.datetime().safeParse(options.now).success ? Date.parse(options.now) : Number.NaN);
  if (Number.isNaN(nowMs)) {
    throw new Error(
      `now: expected an ISO-8601 instant, got ${JSON.stringify(options.now)}`,
    );
  }
  const expiresAtMs = Date.parse(disposition.expiresAt);
  const maxDurationMs = options.maxDurationMs ?? DISPOSITION_MAX_DURATION_MS;
  if (expiresAtMs - nowMs > maxDurationMs) {
    return {
      state: 'over-max',
      expiresAt: disposition.expiresAt,
      detail:
        `expiresAt '${disposition.expiresAt}' exceeds the maximum disposition duration ` +
        `(${String(Math.round(maxDurationMs / 86_400_000))} days from now)`,
    };
  }
  if (nowMs >= expiresAtMs) return { state: 'expired', expiresAt: disposition.expiresAt };
  return { state: 'active', expiresAt: disposition.expiresAt };
}
