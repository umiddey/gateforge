/**
 * Twin path coverage (E64), witness side: what the observation proxy
 * records about a request when the owner asked to know whether a raw
 * test and its witnessed twin exercised the same path.
 *
 * The reported bug was GREEN. A raw test and its witnessed twin shared
 * a helper whose parameter defaults sent them down different paths (the
 * list call carried `?tab=all` in one and `?tab=open` in the other), so
 * "green three times" proved nothing about the path the witnessed twin
 * covered and nothing in the run said so.
 *
 * What this module fixes is the RECORD, not the verdict. A shape is
 * computed at request-arrival time from the method and target the proxy
 * already saw, and only the shape is kept: a method, a route TEMPLATE
 * and the values of the owner-declared query-key allowlist. The raw URL
 * is never stored, so there is nothing here to leak — a shape list is
 * something an owner pastes into a bug.
 *
 * Both twins' traffic arrives on the SAME kind of channel: the
 * dedicated per-session proxy the run already wires. A raw twin issues
 * no evidence because it never calls the evidence API; the witness
 * additionally refuses every submission from a session the supervisor
 * marked observation-only, so "can satisfy nothing" is enforced rather
 * than assumed.
 */
import { readFileSync } from 'node:fs';
import { compareStrings, type RouteInventory, type TwinShape, type TwinShapeOptions, twinShapeOf } from '@gate-forge/core';

/** The switch that turns twin shape recording on for a run. */
export const TWIN_SHAPES_ON = 'on';

/** The recorded shape options one run's proxy uses. */
export interface TwinShapePlan extends TwinShapeOptions {
  /** Owner-declared query keys whose values a shape may carry. */
  readonly queryKeys: readonly string[];
}

/**
 * Reads the route inventory the shapes resolve against.
 *
 * The file is the engine's own compiled endpoint list — a shape may
 * name a route template, never a concrete id — so a run whose file is
 * missing or unreadable resolves shapes without an inventory (the
 * identifier-blind fallback), never with a guess.
 *
 * Args:
 *   path: absolute path to the engine-written inventory document.
 *
 * Returns:
 *   RouteInventory | undefined: the templates, or undefined when the
 *   document is absent/unreadable/not a template list.
 */
function readInventory(path: string | undefined): RouteInventory | undefined {
  if (path === undefined || path === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('templates' in parsed)) return undefined;
  const templates = parsed.templates;
  if (!Array.isArray(templates)) return undefined;
  const names = templates.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return names.length === 0 ? undefined : { templates: names };
}

/**
 * Parses the twin-shape options for one run.
 *
 * Parsed fail-closed on the SWITCH and lenient on the inventory: a run
 * that asked for twin shapes and misconfigured the allowlist is a
 * configuration error the owner must see, while a missing inventory
 * only costs the shapes their route templates.
 *
 * Args:
 *   shapes: the `GATEFORGE_TWIN_SHAPES` value (`'on'` switches on).
 *   queryKeys: comma-separated owner allowlist.
 *   inventoryPath: absolute path to the engine-written route inventory.
 *
 * Returns:
 *   TwinShapePlan | null: the plan, or null for the byte-identical
 *   no-twin-shapes path.
 *
 * @throws Error: when the switch is malformed or an allowlist entry is empty.
 */
export function parseTwinShapePlan(input: {
  shapes: string | undefined;
  queryKeys: string | undefined;
  inventoryPath: string | undefined;
}): TwinShapePlan | null {
  if (input.shapes === undefined || input.shapes === '') return null;
  if (input.shapes !== TWIN_SHAPES_ON) {
    throw new Error(
      `twin shape recording: GATEFORGE_TWIN_SHAPES must be '${TWIN_SHAPES_ON}' or absent, got ${JSON.stringify(input.shapes)}`,
    );
  }
  const queryKeys =
    input.queryKeys === undefined || input.queryKeys === ''
      ? []
      : input.queryKeys.split(',').map((key) => {
          const trimmed = key.trim();
          if (trimmed === '') {
            throw new Error('twin shape recording: GATEFORGE_TWIN_QUERY_KEYS has an empty entry');
          }
          return trimmed;
        });
  const inventory = readInventory(input.inventoryPath);
  return {
    queryKeys: [...queryKeys].sort(compareStrings),
    ...(inventory === undefined ? {} : { inventory }),
  };
}

/**
 * Computes one request's twin shape, deduplicated per session.
 *
 * A test that loads the same list three times recorded it three times;
 * the comparison only ever asks "did this twin ever make this request",
 * so an already-recorded shape is not appended again. The result is a
 * small, stable list an owner can read.
 *
 * Args:
 *   recorded: the session's shapes so far (mutated in place).
 *   method: the request method the proxy saw.
 *   url: the request target (path plus query), never stored.
 *   plan: this run's shape options.
 *
 * Returns:
 *   void: appends to `recorded` when the shape is new.
 */
export function recordTwinShape(
  recorded: TwinShape[],
  method: string,
  url: string,
  plan: TwinShapePlan,
): void {
  const shape = twinShapeOf({ method, url }, plan);
  const identity = JSON.stringify(shape);
  if (recorded.some((existing) => JSON.stringify(existing) === identity)) return;
  recorded.push(shape);
}
