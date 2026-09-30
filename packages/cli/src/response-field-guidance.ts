/**
 * The frontend-read / response-model gap advisory (plan 2026-09-25 Phase
 * 4b item 5).
 *
 * A real merge request shipped a frontend that read `invoice.dueDate`
 * after the FastAPI response model had dropped that field. Nothing failed:
 * every test mocked the response or tolerated `undefined`, and the screen
 * silently showed nothing. The static proof is a cross-check of two facts
 * the packs already own — the response fields a call site reads
 * (pack-http, `responseReads`) and the wire names a route's response
 * model answers to (pack-fastapi, `responseModelFields`) — over the
 * endpoint compiler's existing frontend-call/server-route join.
 *
 * This module is the whole rule, as a pure function of the joined
 * endpoints. It NEVER blocks: the findings ride the report's advisory
 * channel, cause `RESPONSE_FIELD_MISSING_FROM_MODEL`, and the exit code
 * is computed over verdicts and blocking entries alone.
 *
 * Silence is the default. A field counts as present when the model
 * declares it under the same name, under the other case style
 * (`due_date` ≡ `dueDate`), or under a declared alias; an endpoint with no
 * proven response model, a call that joins no route, a read this pass
 * could not attribute to the call, or a malformed fact all produce
 * nothing at all — a repository without both packs renders a report with
 * exactly the bytes it had before this check existed.
 */
import { CAUSE_NEXT_ACTIONS, type BlockingEntry, type Location } from '@gate-forge/core';
import type { HttpContractFact, HttpLocation } from '@gate-forge/http-contract';

/** One joined endpoint, as much of it as this check reads. */
export interface ResponseFieldEndpoint {
  /** `<METHOD> <canonicalPath>`, exactly as the compiler names it. */
  readonly identity: string;
  readonly method: string;
  readonly canonicalPath: string;
  /** Every server-route fact behind the endpoint. */
  readonly routes: readonly HttpContractFact[];
  /** Every frontend-call fact the join attached to the endpoint. */
  readonly calls: readonly HttpContractFact[];
}

/** One field a frontend reads that no response model of the route declares. */
export interface ResponseFieldGap {
  /** `<METHOD> <canonicalPath>` of the endpoint that resolves the call. */
  identity: string;
  method: string;
  canonicalPath: string;
  /** The field name exactly as the frontend writes it. */
  field: string;
  /** Where the frontend reads it. */
  location: Location;
  /** Every wire name the proven response models do declare, in order. */
  declared: string[];
  /** How many call sites read this field from this endpoint. */
  reads: number;
}

/** The comparison key of a field name: case and `_` separators do not count. */
function fieldKey(name: string): string {
  return name.replace(/_/g, '').toLowerCase();
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** A well-formed response read, or null for anything else. */
function readOf(
  value: unknown,
): { field: string; location: HttpLocation; chain: number | null } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const read = value as { field?: unknown; location?: unknown };
  if (typeof read.field !== 'string' || read.field.length === 0) return null;
  const location = read.location as { file?: unknown; line?: unknown; col?: unknown } | undefined;
  if (location === undefined || typeof location !== 'object' || location === null) return null;
  if (typeof location.file !== 'string' || location.file.length === 0) return null;
  if (typeof location.line !== 'number' || !Number.isInteger(location.line) || location.line < 1) return null;
  if (typeof location.col !== 'number' || !Number.isInteger(location.col) || location.col < 0) return null;
  const chain = (value as { chain?: unknown }).chain;
  return {
    field: read.field,
    location: location as HttpLocation,
    chain: typeof chain === 'number' && Number.isInteger(chain) && chain >= 0 ? chain : null,
  };
}

/** The proven wire names of one route, or null when it declares none. */
function declaredFieldsOf(route: HttpContractFact): string[] | null {
  const fields = route.responseModelFields;
  if (fields === undefined || fields.length === 0) return null;
  return fields;
}

/**
 * The exact sentence every surface repeats for one gap: the endpoint the
 * call resolves to, the field the frontend reads, the read's own
 * location, and the names the model does declare.
 */
function gapSentence(gap: ResponseFieldGap): string {
  const reads =
    gap.reads > 1 ? ` (read at ${gap.reads} call sites)` : ` (read at ${gap.location.file}:${String(gap.location.line)})`;
  return (
    `the frontend reads '${gap.field}' from ${gap.identity}${reads}, which its response model does not ` +
    `declare (declared: ${gap.declared.join(', ')}); that read is undefined at runtime`
  );
}

/**
 * Every field a frontend reads off an endpoint whose proven response
 * model does not declare it, in a deterministic order.
 *
 * Args:
 *   endpoints: The endpoint compiler's inventory (route/call facts are
 *     already joined; an endpoint with no calls reads nothing).
 *
 * Returns:
 *   ResponseFieldGap[]: one entry per endpoint and unread field; empty
 *     when every read is declared, and empty whenever no route of the
 *     repository carries a proven response model.
 */
export function responseFieldGaps(
  endpoints: readonly ResponseFieldEndpoint[],
): ResponseFieldGap[] {
  const gaps: ResponseFieldGap[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.calls.length === 0) continue;
    const declared: string[] = [];
    const declaredKeys = new Set<string>();
    for (const route of endpoint.routes) {
      const fields = declaredFieldsOf(route);
      if (fields === null) continue;
      for (const name of fields) {
        if (!declared.includes(name)) declared.push(name);
        declaredKeys.add(fieldKey(name));
      }
    }
    if (declaredKeys.size === 0) continue;
    // One entry per (endpoint, field); the first read names the location.
    const found = new Map<string, ResponseFieldGap>();
    for (const call of endpoint.calls) {
      // A `||` / `??` chain is ONE decision about ONE result
      // (`res.data?.invoice_id || res.data?.invoice?.id`): when any operand
      // reads a field the model declares, the others are the defensive
      // fallbacks for it and no field is missing. A chain in which no
      // operand is declared is reported whole.
      const chains = new Map<number, boolean[]>();
      const reads: Array<{ field: string; location: HttpLocation; chain: number | null }> = [];
      for (const raw of call.responseReads ?? []) {
        const read = readOf(raw);
        if (read === null) continue;
        reads.push(read);
        if (read.chain === null) continue;
        const declaredHere = chains.get(read.chain) ?? [];
        declaredHere.push(declaredKeys.has(fieldKey(read.field)));
        chains.set(read.chain, declaredHere);
      }
      for (const read of reads) {
        if (declaredKeys.has(fieldKey(read.field))) continue;
        if (read.chain !== null && (chains.get(read.chain) ?? []).some((declared) => declared)) continue;
        const existing = found.get(read.field);
        if (existing === undefined) {
          found.set(read.field, {
            identity: endpoint.identity,
            method: endpoint.method,
            canonicalPath: endpoint.canonicalPath,
            field: read.field,
            location: { file: read.location.file, line: read.location.line, col: read.location.col },
            declared: [...declared],
            reads: 1,
          });
        } else {
          existing.reads += 1;
        }
      }
    }
    gaps.push(...found.values());
  }
  gaps.sort(
    (left, right) =>
      compareText(left.identity, right.identity) ||
      compareText(left.location.file, right.location.file) ||
      left.location.line - right.location.line ||
      left.location.col - right.location.col ||
      compareText(left.field, right.field),
  );
  return gaps;
}

/**
 * The advisory entries for the gaps {@link responseFieldGaps} finds. Never
 * blocking: these ride the report's advisory channel, so the exit code is
 * unchanged whatever they say.
 *
 * Args:
 *   endpoints: The endpoint compiler's inventory.
 *
 * Returns:
 *   BlockingEntry[]: one `finding` per gap; empty when there are none, so
 *     a repository without both packs reports the exact same bytes.
 */
export function responseFieldAdvisories(
  endpoints: readonly ResponseFieldEndpoint[],
): BlockingEntry[] {
  return responseFieldGaps(endpoints).map((gap) => ({
    kind: 'finding' as const,
    resourceId: null,
    name: null,
    detail: gapSentence(gap),
    location: { file: gap.location.file, line: gap.location.line, col: gap.location.col },
    cause: 'RESPONSE_FIELD_MISSING_FROM_MODEL' as const,
    nextAction: CAUSE_NEXT_ACTIONS.RESPONSE_FIELD_MISSING_FROM_MODEL,
  }));
}
