/**
 * Twin path coverage (E64): the pure half of "did the raw test and its
 * witnessed twin actually exercise the same requests?"
 *
 * The reported bug is not a red test. It is a GREEN one: a raw test and
 * its witnessed twin shared a helper whose parameter defaults sent them
 * down different paths — the list call carried `?tab=all` in one and
 * `?tab=open` in the other — so "green three times" proved nothing
 * about the path the witnessed twin covered, and nobody could say so
 * from the run.
 *
 * This module turns two sets of observed requests into the honest
 * question: which request shapes did one twin exercise that the other
 * never did? The observation itself lives engine-side (the proxy); the
 * comparison, the shape vocabulary and the finding text live here, in
 * core, because they are domain logic and must be testable without a
 * browser.
 *
 * What a shape may contain is deliberately narrow. A shape is a method,
 * a route TEMPLATE (never a concrete id) and the values of an
 * owner-declared query-key allowlist. No body, no header, no cookie, no
 * non-allowlisted value: a shape list is something an owner pastes into
 * a bug, so it must be impossible for it to carry a secret.
 */
import { compareStrings } from './graph/util.js';

/** One observed request, as the observation-only proxy saw it. */
export interface ObservedRequest {
  /** Uppercase method (GET, POST, ...). */
  method: string;
  /** The request target: path plus query, exactly as it arrived. */
  url: string;
}

/** The route inventory a shape resolves against (compiled endpoints). */
export interface RouteInventory {
  /** Route templates in the engine's `{}` grammar, e.g. `/accounts/{}`. */
  templates: readonly string[];
}

/** Owner-declared query keys whose VALUES a shape may carry. */
export interface TwinShapeOptions {
  /** The compiled http.endpoint templates, when the run has them. */
  inventory?: RouteInventory;
  /**
   * Query keys whose values may be recorded (`enforcement.twinQueryKeys`).
   * Absent or empty = keys only: the shape says `tab` was sent and
   * nothing about what it said.
   */
  queryKeys?: readonly string[];
}

/** One request shape: comparable, and free of anything identifying. */
export interface TwinShape {
  /** Uppercase method. */
  method: string;
  /** The route template the request resolved to (never a concrete id). */
  route: string;
  /** Allowlisted query values, sorted by key. Absent = keys only. */
  query?: Record<string, string>;
}

/** One twin's observed request shapes, with the test that produced them. */
export interface TwinObservation {
  /** The logical key of the test that made these requests. */
  logicalKey: string;
  /** The shapes it exercised, in observation order. */
  shapes: readonly TwinShape[];
}

/** One direction of a divergence between two twins. */
export interface TwinDivergence {
  /** The twin that DID exercise the shape. */
  presentIn: string;
  /** The twin that never did. */
  missingFrom: string;
  /** The shape itself (method, route template, allowlisted values). */
  shape: TwinShape;
}

/** Segments that identify nothing: an id is an id wherever it appears. */
const IDENTIFIER_SEGMENT = /^(\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** Splits a request target into its path and its decoded query pairs. */
function splitTarget(url: string): { path: string; query: [string, string][] } {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const search = cut === -1 ? '' : url.slice(cut + 1).split('#')[0] ?? '';
  const query =
    search === ''
      ? []
      : search.split('&').map((pair) => {
          const equals = pair.indexOf('=');
          return equals === -1
            ? ([pair, ''] as [string, string])
            : ([pair.slice(0, equals), decodeURIComponent(pair.slice(equals + 1).replace(/\+/g, ' '))] as [
                string,
                string,
              ]);
        });
  return { path: path === '' ? '/' : path, query };
}

/**
 * Rewrites a concrete path to a template: every numeric or UUID segment
 * becomes `{}`. Used when the run has no compiled route inventory to
 * resolve against, so a shape still never carries an identifier.
 */
function templatizePath(path: string): string {
  return path
    .split('/')
    .map((segment) => (IDENTIFIER_SEGMENT.test(segment) ? '{}' : segment))
    .join('/');
}

/**
 * Resolves a concrete path against the compiled route inventory: the
 * first template whose segment count and static segments match wins. A
 * run with no inventory (or no match) falls back to the identifier-
 * blind template, never to the raw path.
 */
function routeOf(path: string, inventory: RouteInventory | undefined): string {
  const segments = path.split('/');
  for (const template of inventory?.templates ?? []) {
    const parts = template.split('/');
    if (parts.length !== segments.length) continue;
    const matches = parts.every((part, index) => part === '{}' || part === segments[index]);
    if (matches) return template;
  }
  return templatizePath(path);
}

/**
 * Turns one observed request into its comparable shape.
 *
 * Args:
 *   request: the method and target the proxy observed.
 *   options: the run's route inventory and owner-declared query keys.
 *
 * Returns:
 *   TwinShape: method + route template + allowlisted query values.
 */
export function twinShapeOf(request: ObservedRequest, options: TwinShapeOptions = {}): TwinShape {
  const { path, query } = splitTarget(request.url);
  const allowlist = new Set(options.queryKeys ?? []);
  const values: Record<string, string> = {};
  for (const [key, value] of [...query].sort((left, right) => compareStrings(left[0], right[0]))) {
    // The KEY is always recorded; the VALUE only when the owner named
    // this key. A non-allowlisted value cannot reach a shape, and a
    // shape is what every report and state document carries.
    if (allowlist.has(key)) values[key] = value;
  }
  return {
    method: request.method.toUpperCase(),
    route: routeOf(path, options.inventory),
    ...(Object.keys(values).length === 0 ? {} : { query: values }),
  };
}

/** The stable comparable identity of a shape. */
function shapeKey(shape: TwinShape): string {
  const query = Object.keys(shape.query ?? {})
    .sort(compareStrings)
    .map((key) => `${key}=${(shape.query as Record<string, string>)[key] as string}`)
    .join('&');
  return `${shape.method} ${shape.route}${query === '' ? '' : `?${query}`}`;
}

/** Renders one shape for a human, naming exactly what it carries. */
function describeShape(shape: TwinShape): string {
  const query = Object.keys(shape.query ?? {});
  if (query.length === 0) return `${shape.method} ${shape.route}`;
  return `${shape.method} ${shape.route}?${query
    .sort(compareStrings)
    .map((key) => `${key}=${(shape.query as Record<string, string>)[key] as string}`)
    .join('&')}`;
}

/**
 * Compares two twins' shapes and returns both directions of the
 * divergence: what the witnessed twin did that the raw twin never did,
 * and what the raw twin did that the witnessed twin never did. A shape
 * both exercised is not reported — twins that agree are the healthy
 * case and must stay silent.
 *
 * Args:
 *   witnessed: the witnessed twin's shapes.
 *   raw: the raw twin's shapes.
 *
 * Returns:
 *   TwinDivergence[]: every one-sided shape, witnessed-side first,
 *   deterministic in shape identity.
 */
export function twinPathDivergence(
  witnessed: TwinObservation,
  raw: TwinObservation,
): TwinDivergence[] {
  const rawKeys = new Set(raw.shapes.map(shapeKey));
  const witnessedKeys = new Set(witnessed.shapes.map(shapeKey));
  const oneSided = (shapes: readonly TwinShape[], other: ReadonlySet<string>, presentIn: string, missingFrom: string): TwinDivergence[] =>
    shapes
      .filter((shape) => !other.has(shapeKey(shape)))
      .map((shape) => ({ presentIn, missingFrom, shape }));
  return [
    ...oneSided(witnessed.shapes, rawKeys, witnessed.logicalKey, raw.logicalKey),
    ...oneSided(raw.shapes, witnessedKeys, raw.logicalKey, witnessed.logicalKey),
  ];
}

/** The finding text a divergence produces, naming BOTH tests and the shape. */
export function twinDivergenceDetail(divergence: TwinDivergence): string {
  return (
    `${describeShape(divergence.shape)} is exercised by '${divergence.presentIn}' and never by ` +
    `'${divergence.missingFrom}' — the twins do not cover the same request path`
  );
}

/**
 * The tag a title carries to declare itself the WITNESSED twin. It is
 * part of the title convention, not a gate: the link is a naming
 * convention an owner follows, and the engine only reads it when the
 * owner switched twin coverage on.
 */
export const WITNESSED_TITLE_TAG = '[witnessed]';

/** The one catalog fact a twin link needs: which test, and its title. */
export interface TwinCandidate {
  /** Stable logical key (the catalog's `logicalKey`). */
  logicalKey: string;
  /** The test's own title (the last segment of its title path). */
  title: string;
}

/** One linked raw/witnessed pair, with the reason the link exists. */
export interface TwinLink {
  /** The witnessed test: the one the run grades. */
  witnessed: string;
  /** The raw test it is the twin of. */
  raw: string;
  /** Which rule produced the link (for the run's own explanation). */
  source: 'test-map' | 'title';
}

/**
 * Resolves the raw/witnessed pairs a run should compare.
 *
 * Two rules, in that order, and never a guess:
 * - `twinOf`: the explicit test-map declaration — the only link that
 *   survives a rename of either test, because it names logical keys.
 * - the title convention: a witnessed title that carries
 *   {@link WITNESSED_TITLE_TAG} links to the untagged title with the
 *   same stem: `X raw`, else the one `X raw: <description>`, else a
 *   bare `X`.
 *
 * A link is only returned when BOTH tests exist in the catalog: a
 * dangling `twinOf` or a title with no partner names nothing, because
 * a pair with one missing side has no shapes to compare and a finding
 * about it would be a ghost.
 *
 * Args:
 *   candidates: every test the catalog knows (logical key + title).
 *   twinOf: explicit `witnessed -> raw` logical-key declarations.
 *
 * Returns:
 *   TwinLink[]: every resolvable pair, deterministic in witnessed key.
 */
export function twinLinksFor(
  candidates: readonly TwinCandidate[],
  twinOf: Readonly<Record<string, string>> = {},
): TwinLink[] {
  const known = new Set(candidates.map((candidate) => candidate.logicalKey));
  const links = new Map<string, TwinLink>();
  for (const witnessed of [...candidates].sort((left, right) => compareStrings(left.logicalKey, right.logicalKey))) {
    const declared = twinOf[witnessed.logicalKey];
    if (declared !== undefined && known.has(declared) && declared !== witnessed.logicalKey) {
      links.set(witnessed.logicalKey, { witnessed: witnessed.logicalKey, raw: declared, source: 'test-map' });
      continue;
    }
    const tagIndex = witnessed.title.lastIndexOf(WITNESSED_TITLE_TAG);
    if (tagIndex === -1) continue;
    const stem = witnessed.title.slice(0, tagIndex).trim();
    if (stem === '') continue;
    // `X [witnessed]` pairs with `X raw` first, then with the ONE
    // `X raw: <description>`, then with a bare `X`: the explicit raw twin
    // is the owner's clearer statement, and a same-title bare match is
    // only taken when nothing else claims it.
    const untagged = candidates.filter(
      (candidate) => candidate.logicalKey !== witnessed.logicalKey && !candidate.title.includes(WITNESSED_TITLE_TAG),
    );
    const described = untagged.filter((candidate) => candidate.title.startsWith(`${stem} raw:`));
    // A described partner is only unambiguous when the label names ONE
    // test on each side: two witnessed tests under one label (or two
    // described raw ones) leave the pairing to the owner (`twinOf`) —
    // never a guess, and never a fallback to a bare title.
    const witnessedUnderLabel = candidates.filter((candidate) => {
      const index = candidate.title.lastIndexOf(WITNESSED_TITLE_TAG);
      return index !== -1 && candidate.title.slice(0, index).trim() === stem;
    }).length;
    const describedPartner = described.length === 1 && witnessedUnderLabel === 1 ? described[0] : undefined;
    const partner = untagged.find((candidate) => candidate.title === `${stem} raw`) ?? describedPartner;
    if (partner === undefined && described.length > 0) continue;
    const bare =
      partner ??
      candidates.find(
        (candidate) =>
          candidate.logicalKey !== witnessed.logicalKey &&
          !candidate.title.includes(WITNESSED_TITLE_TAG) &&
          candidate.title === stem,
      );
    if (partner === undefined && bare !== undefined) {
      // A bare `X` may also be the stem of another witnessed title's
      // partner; the first witnessed key (sorted) owns it, so the same
      // raw test is never reported as the twin of two witnessed ones.
      const alreadyLinked = [...links.values()].some((link) => link.raw === bare.logicalKey);
      if (alreadyLinked) continue;
    }
    if (bare !== undefined) {
      links.set(witnessed.logicalKey, {
        witnessed: witnessed.logicalKey,
        raw: bare.logicalKey,
        source: 'title',
      });
    }
  }
  return [...links.values()].sort((left, right) => compareStrings(left.witnessed, right.witnessed));
}
