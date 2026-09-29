/**
 * Witness-side authenticated session for kit adapters.
 *
 * Credentials live in the WITNESS process environment and nowhere else:
 * every seat names its env vars in the adapter config, the values are
 * read at call time, and nothing here logs, prints, or returns them. A
 * seat performs exactly one login POST (the same request a human
 * browser performs) and then issues GET-only evidence reads with the
 * session it obtained; a read rejected with 401 triggers ONE re-login
 * and one retry, never a loop.
 *
 * This module can authenticate and read. It cannot create, update, or
 * delete business state — no method here issues anything but the
 * declared login POST and GETs.
 */
import type { BearerSeat, CookieLoginSeat, HttpAdapterAuth } from './config.js';

/** One cached seat session (per base URL). */
interface SeatSession {
  /** Credential header value, or null while not logged in. */
  authorization: string | null;
  /** Cookie header value, or null while not logged in. */
  cookie: string | null;
}

/** Everything one seat needs to authenticate a read. */
interface ResolvedSeat {
  kind: 'bearer' | 'cookie-login';
  /** The seat's declared name (what a diagnostic quotes). */
  name: string;
  /** Bearer token seat. */
  bearer?: BearerSeat;
  /** Cookie-login seat. */
  login?: CookieLoginSeat;
}

/** Sessions keyed by `<baseUrl>|<seat>`, shared by every read of one kit adapter. */
export type SessionStore = Map<string, SeatSession>;

/** The result of one kit-issued GET. */
export interface KitGetResult {
  /** HTTP status. */
  status: number;
  /** Response headers (fingerprint marker lives here). */
  headers: Headers;
  /** Parsed JSON body, or undefined for a non-JSON body. */
  body: unknown;
}

/** What one probe read showed, as the kit's own read path saw it. */
export interface KitProbeResult {
  /** The exact path the read GET hit. */
  path: string;
  /** HTTP status of that GET. */
  status: number;
  /** Response headers (the environment marker lives here). */
  headers: Headers;
}

/** The witness env vars a seat failure is about (names, never values). */
export interface KitAuthFailure {
  /** The seat that could not authenticate. */
  seat: string;
  /** Env var names the seat needs, or null when the login was rejected. */
  envVars: readonly string[] | null;
}

/** Raised when the witness environment does not carry a credential. */
export class KitAuthError extends Error {
  /** Which seat failed, and which env vars it needs (null: rejected login). */
  readonly failure: KitAuthFailure | null;

  /**
   * Builds one auth failure.
   *
   * Args:
   *   message: the plain message a witnessed run shows.
   *   failure: the structured facts a probe reports, when it has them.
   */
  constructor(message: string, failure: KitAuthFailure | null = null) {
    super(message);
    this.name = 'KitAuthError';
    this.failure = failure;
  }
}

/** Raised when a read only succeeds through a redirect. */
export class KitRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KitRedirectError';
  }
}

/**
 * Resolves the configured seat (or fails closed naming the ones there
 * are).
 *
 * Args:
 *   auth: the adapter's declared auth.
 *
 * Returns:
 *   ResolvedSeat | null: the seat, or null for `kind: 'none'`.
 * @throws KitAuthError when the named seat does not exist.
 */
function resolveSeat(auth: HttpAdapterAuth): ResolvedSeat | null {
  if (auth.kind === 'none') return null;
  const seats: Readonly<Record<string, BearerSeat | CookieLoginSeat>> = auth.seats;
  const name = auth.seat ?? Object.keys(seats)[0];
  if (name === undefined) {
    throw new KitAuthError(
      'auth declares no seats: add a named seat (credentials are read from the witness environment)',
    );
  }
  const seat = seats[name];
  if (seat === undefined) {
    throw new KitAuthError(
      `auth seat '${name}' is not declared (available: ${Object.keys(seats).sort().join(', ')})`,
    );
  }
  if (auth.kind === 'bearer') {
    const bearer = seat as BearerSeat;
    if (typeof bearer.tokenEnv !== 'string') {
      throw new KitAuthError(`auth seat '${name}' must declare tokenEnv (a witness env var)`);
    }
    return { kind: 'bearer', name, bearer };
  }
  const login = seat as CookieLoginSeat;
  if (typeof login.loginPath !== 'string' || typeof login.credentials !== 'object') {
    throw new KitAuthError(
      `auth seat '${name}' must declare loginPath and credentials (field -> witness env var)`,
    );
  }
  return { kind: 'cookie-login', name, login };
}


/**
 * The credential header one GET carries, logging in first when needed.
 *
 * Args:
 *   seat: the resolved seat.
 *   seatKey: session cache key.
 *   baseUrl: the adapter base the read targets.
 *   sessions: this kit's session store.
 *
 * Returns:
 *   Promise<Record<string, string>>: headers to merge into the read.
 * @throws KitAuthError when credentials are absent or login is rejected.
 */
async function credentialHeaders(
  seat: ResolvedSeat,
  seatKey: string,
  baseUrl: string,
  sessions: SessionStore,
): Promise<Record<string, string>> {
  // Credentials are read from the witness process environment, never
  // from the repo, argv, or the suite — and a seat that cannot be
  // satisfied is named by its env vars, never by a bare 401 later.
  const config: BearerSeat | CookieLoginSeat =
    seat.kind === 'bearer' ? (seat.bearer as BearerSeat) : (seat.login as CookieLoginSeat);
  const envVars = 'tokenEnv' in config ? [config.tokenEnv] : Object.values(config.credentials);
  const missing = envVars.filter((name) => {
    const value = process.env[name];
    return value === undefined || value === '';
  });
  if (missing.length > 0) {
    throw new KitAuthError(
      `adapter seat '${seat.name}' needs ${missing.join(', ')} in the WITNESS process ` +
        'environment (never in the repo, argv, or the suite)',
      { seat: seat.name, envVars: missing },
    );
  }
  if ('tokenEnv' in config) {
    const scheme = config.scheme ?? 'Bearer';
    return { authorization: `${scheme} ${String(process.env[config.tokenEnv])}` };
  }
  const login = config;
  const cached = sessions.get(seatKey);
  if (cached?.cookie != null) return { cookie: cached.cookie };
  const body: Record<string, string> = {};
  for (const [field, envVar] of Object.entries(login.credentials)) {
    body[field] = String(process.env[envVar]);
  }
  const response = await fetch(`${baseUrl}${login.loginPath}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(login.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new KitAuthError(
      `adapter seat '${seat.name}' login failed: POST ${login.loginPath} -> ${String(response.status)}`,
    );
  }
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? ''];
  const pairs = cookies
    .flatMap((header) => header.split(/,(?=\s*[^;=]+=[^;]*)/))
    .map((header) => header.split(';')[0]?.trim() ?? '')
    .filter((pair) => pair.includes('='));
  const wanted = pairs.filter((pair) => {
    const name = pair.slice(0, pair.indexOf('='));
    return login.cookieName === undefined || name === login.cookieName;
  });
  if (wanted.length === 0) {
    throw new KitAuthError(
      `adapter seat '${seat.name}' login set no ${
        login.cookieName === undefined ? '' : `'${login.cookieName}' `
      }cookie`,
    );
  }
  const cookie = wanted.join('; ');
  sessions.set(seatKey, { authorization: null, cookie });
  return { cookie };
}

/** The kit's per-adapter read transport. */
export interface SessionReaderOptions {
  /** The adapter's declared auth (default: none). */
  auth?: HttpAdapterAuth;
  /** Registry identity, for diagnostics. */
  resourceId: string;
  /** The witness-adapter context the read runs under. */
  ctx: { baseUrl: string; headers?: Record<string, string> };
  /** Per-request timeout in ms (default 10000). */
  timeoutMs?: number;
  /** Session store shared across reads (one login, then reused). */
  sessions?: SessionStore;
}

/**
 * Builds the kit's GET transport for one adapter invocation.
 *
 * Args:
 *   options: declared auth, resource id, and the witness context.
 *
 * Returns:
 *   (path: string) => Promise<KitGetResult>: one read, login included.
 * @throws KitAuthError on missing/rejected credentials; KitRedirectError
 *   when the app answers the read with a redirect (a read that only
 *   works through a redirect is never a stable evidence path).
 */
export function createSessionReader(options: SessionReaderOptions): (path: string) => Promise<KitGetResult> {
  const { auth, resourceId, ctx } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const baseUrl = ctx.baseUrl.replace(/\/$/, '');
  const seat = auth === undefined || auth.kind === 'none' ? null : resolveSeat(auth);
  const seatKey = `${baseUrl}|${seat?.name ?? ''}`;
  // One store per kit adapter: the first read logs in, later reads
  // reuse the session until the app rejects it with 401.
  const sessions: SessionStore = options.sessions ?? new Map();

  /**
   * Issues one GET and parses its JSON body.
   *
   * Args:
   *     path: absolute path (with query) to read.
   *     credential: credential headers to attach.
   *
   *   Returns:
   *     Promise<KitGetResult>: status, headers, parsed body.
   * @throws KitRedirectError when the app answers with a redirect.
   */
  const getOnce = async (
    path: string,
    credential: Record<string, string>,
  ): Promise<KitGetResult> => {
    const response = await fetch(`${baseUrl}${path}`, {
      // A read that only works through a redirect is not a stable
      // evidence path: never follow one silently (E28).
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        ...(ctx.headers ?? {}),
        ...credential,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response
      .json()
      .catch(() => undefined);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      throw new KitRedirectError(
        `${resourceId}: GET ${path} answered ${String(response.status)}${
          location === null ? '' : ` -> ${location}`
        }; a read that only works through a redirect is not a stable evidence path — point ` +
          'readPath/listPath at the path the app finally serves',
      );
    }
    return { status: response.status, headers: response.headers, body };
  };

  if (seat === null) {
    return async (path: string): Promise<KitGetResult> => getOnce(path, {});
  }

  return async (path: string): Promise<KitGetResult> => {
    let credential = await credentialHeaders(seat, seatKey, baseUrl, sessions);
    let result = await getOnce(path, credential);
    if (result.status === 401) {
      // One re-login, one retry: an expired session must not become a loop.
      sessions.delete(seatKey);
      credential = await credentialHeaders(seat, seatKey, baseUrl, sessions);
      result = await getOnce(path, credential);
    }
    return result;
  };
}
