/**
 * Engine-side signature profiles for behavior cases (plan 2026-09-25
 * Phase 1): the ONE grammar a `signatureProfile` string may use, parsed
 * and validated identically by the config schema (fail fast, at config
 * time) and by the witness-owned request driver (fail closed, at run
 * time).
 *
 * Grammar (a media-type style name plus bounded parameters):
 *
 *   hmac-sha256
 *   hmac-sha256;header=x-hub-signature-256
 *   hmac-sha256;timestampHeader=x-webhook-timestamp;toleranceMs=300000
 *   hmac-sha256;attemptHeader=x-webhook-attempt;attempt=2
 *   hmac-sha256;forgery=signature
 *
 * Why a string and not a nested object: the case action travels from
 * the compiled catalog into the witness, and `signatureProfile` is the
 * single declared key that channel already carries. The profile names
 * what the ENGINE does with a secret it holds — never what a suite
 * claims. A suite cannot ask for a signature it made up: the profile
 * can only select a header name, a timestamp window, an attempt
 * counter, or ask the engine to perform a signature forgery itself.
 *
 * Trust invariants (unchanged by this grammar):
 * - the secret is read from the trusted lease's actor material and
 *   never leaves the witness process;
 * - the signature is computed over the EXACT bytes the driver sends,
 *   never over a re-serialization;
 * - a `forgery` is performed by the engine, deterministically, and
 *   never reveals the secret.
 */

/** Signature algorithms a profile may name. */
export const BEHAVIOR_SIGNATURE_ALGORITHMS = ['hmac-sha256'] as const;

/** Inferred signature algorithm name. */
export type BehaviorSignatureAlgorithm = (typeof BEHAVIOR_SIGNATURE_ALGORITHMS)[number];

/**
 * The deterministic forgeries the engine may perform itself.
 *
 * Only the SIGNATURE side: the engine binds the submitted bytes to the
 * declared fixture, so a body the engine altered after signing is not
 * evidence of anything (the grader refuses it outright). A forged
 * signature is the honest negative case — the body the receiver verifies
 * is exactly the body the owner declared.
 */
export const BEHAVIOR_SIGNATURE_FORGERIES = ['none', 'signature'] as const;

/** Inferred forgery name. */
export type BehaviorSignatureForgery = (typeof BEHAVIOR_SIGNATURE_FORGERIES)[number];

/**
 * The engine-only carrier of a webhook signing secret inside a trusted
 * lease's actor material. It is consumed here, never forwarded as a
 * request header.
 */
export const BEHAVIOR_SIGNING_SECRET_HEADER = 'x-gateforge-signing-secret';

/** Default signature header the profiles stamp. */
export const DEFAULT_SIGNATURE_HEADER = 'x-signature';

/** Default timestamp header the `hmac-sha256` profile stamps. */
export const DEFAULT_SIGNATURE_TIMESTAMP_HEADER = 'x-webhook-timestamp';

/** Default attempt header the `hmac-sha256` profile stamps. */
export const DEFAULT_SIGNATURE_ATTEMPT_HEADER = 'x-webhook-attempt';

/** Header names the engine refuses to sign with or send. */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([BEHAVIOR_SIGNING_SECRET_HEADER]);

/** A parsed, validated signature profile. */
export interface BehaviorSignatureProfile {
  /** The signing algorithm over the exact request bytes. */
  algorithm: BehaviorSignatureAlgorithm;
  /** Header carrying the hex digest. */
  header: string;
  /** Header carrying the engine's timestamp, or null when unstamped. */
  timestampHeader: string | null;
  /** Tolerance the engine requires of its own stamp, in ms. */
  toleranceMs: number | null;
  /** Header carrying the delivery attempt number, or null when absent. */
  attemptHeader: string | null;
  /** The attempt number the engine stamps (1 when no header). */
  attempt: number;
  /** The forgery the engine performs, or `none`. */
  forgery: BehaviorSignatureForgery;
}

/** One profile parameter the grammar accepts. */
const PARAMETER_NAMES: ReadonlySet<string> = new Set([
  'header',
  'timestampHeader',
  'toleranceMs',
  'attemptHeader',
  'attempt',
  'forgery',
]);

/** Upper bound on a declared clock tolerance (24 h). */
const MAX_TOLERANCE_MS = 86_400_000;

/** Upper bound on a declared attempt number. */
const MAX_ATTEMPT = 1000;

/** Header-name grammar (RFC 7230 token, deliberately narrow). */
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** A parsed profile or the exact reason it was refused. */
export type SignatureProfileResult =
  | { ok: true; profile: BehaviorSignatureProfile }
  | { ok: false; error: string };

/**
 * Parses one `signatureProfile` string into a validated profile.
 *
 * Args:
 *   text (string): the declared profile, name plus optional
 *     `;key=value` parameters.
 *
 * Returns:
 *   SignatureProfileResult: the profile, or the reason it was refused.
 *   An unknown algorithm, an unknown parameter, a malformed value, or a
 *   reserved header name never yields a default — the caller fails
 *   closed.
 */
export function parseBehaviorSignatureProfile(text: string): SignatureProfileResult {
  const parts = text.split(';');
  const name = (parts[0] ?? '').trim();
  if ((BEHAVIOR_SIGNATURE_ALGORITHMS as readonly string[]).includes(name) === false) {
    return {
      ok: false,
      error:
        `unsupported signature profile '${name}' — supported: ` +
        `${BEHAVIOR_SIGNATURE_ALGORITHMS.join(', ')} (with optional ;key=value parameters ` +
        `${[...PARAMETER_NAMES].sort().join(', ')})`,
    };
  }
  const profile: BehaviorSignatureProfile = {
    algorithm: name as BehaviorSignatureAlgorithm,
    header: DEFAULT_SIGNATURE_HEADER,
    timestampHeader: DEFAULT_SIGNATURE_TIMESTAMP_HEADER,
    toleranceMs: null,
    attemptHeader: DEFAULT_SIGNATURE_ATTEMPT_HEADER,
    attempt: 1,
    forgery: 'none',
  };
  const seen = new Set<string>();
  for (const part of parts.slice(1)) {
    if (part.trim().length === 0) continue;
    const separator = part.indexOf('=');
    if (separator < 0) return { ok: false, error: `signature profile parameter '${part}' must be key=value` };
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (PARAMETER_NAMES.has(key) === false) {
      return { ok: false, error: `unknown signature profile parameter '${key}'` };
    }
    if (seen.has(key)) return { ok: false, error: `duplicate signature profile parameter '${key}'` };
    seen.add(key);
    if (key === 'header') {
      const header = headerError(value);
      if (header !== null) return { ok: false, error: header };
      profile.header = value;
      continue;
    }
    if (key === 'timestampHeader') {
      if (value === 'none') {
        profile.timestampHeader = null;
        continue;
      }
      const header = headerError(value);
      if (header !== null) return { ok: false, error: header };
      profile.timestampHeader = value;
      continue;
    }
    if (key === 'attemptHeader') {
      if (value === 'none') {
        profile.attemptHeader = null;
        continue;
      }
      const header = headerError(value);
      if (header !== null) return { ok: false, error: header };
      profile.attemptHeader = value;
      continue;
    }
    if (key === 'toleranceMs') {
      const parsed = integerError(value, 0, MAX_TOLERANCE_MS);
      if (parsed !== null) return { ok: false, error: `signature profile toleranceMs: ${parsed}` };
      profile.toleranceMs = Number(value);
      continue;
    }
    if (key === 'attempt') {
      const parsed = integerError(value, 1, MAX_ATTEMPT);
      if (parsed !== null) return { ok: false, error: `signature profile attempt: ${parsed}` };
      profile.attempt = Number(value);
      continue;
    }
    if ((BEHAVIOR_SIGNATURE_FORGERIES as readonly string[]).includes(value) === false) {
      return {
        ok: false,
        error: `signature profile forgery must be one of ${BEHAVIOR_SIGNATURE_FORGERIES.join(', ')} (got '${value}')`,
      };
    }
    profile.forgery = value as BehaviorSignatureForgery;
  }
  if (profile.timestampHeader === null) profile.toleranceMs = null;
  if (profile.attemptHeader === null) profile.attempt = 1;
  return { ok: true, profile };
}

/** Rejects a malformed or reserved header name; null when legal. */
function headerError(value: string): string | null {
  if (HEADER_NAME.test(value) === false) {
    return `'${value}' is not a legal header name`;
  }
  if (FORBIDDEN_HEADERS.has(value.toLowerCase())) {
    return `'${value}' is reserved for the engine-side signing secret and can never be stamped`;
  }
  return null;
}

/** Rejects a non-integer or out-of-range value; null when legal. */
function integerError(value: string, min: number, max: number): string | null {
  if (/^\d+$/.test(value) === false) return `'${value}' is not a non-negative integer`;
  const parsed = Number(value);
  if (parsed < min || parsed > max) return `'${value}' is outside [${String(min)}, ${String(max)}]`;
  return null;
}
