/**
 * Route-folder plane PROPOSALS for `gateforge init` (problem 13, owner
 * decision D1 = ask, never infer).
 *
 * A fresh init on an existing repository leaves every discovered endpoint
 * without a plane, and one owner answer per ROUTE FOLDER is the smallest
 * honest answer — an `accounts` route can serve master data even when the
 * `accounts` model is tenant-scoped, so a route folder is never classified
 * from the model it happens to link to.
 *
 * What this module does:
 * - `collectRoutePlaneFacts` runs the repository's own discovery (the
 *   configured plugins plus the endpoint compiler) and reduces every
 *   compiled endpoint to the four facts a folder question needs. It
 *   THROWS when discovery fails — the caller decides how to warn; a
 *   silent empty list would read as "nothing to ask" and hide the run.
 * - `proposeRouteFolderPlanes` groups the plane-unresolved endpoints by the
 *   directory of their SERVER ROUTE file and returns one proposal per
 *   folder. It is PURE: it writes nothing, applies nothing, and the hint
 *   it carries is display-only evidence, never an answer.
 *
 * The hint is deliberately narrow: it is the plane of the linked models,
 * and it is withheld unless every linked model behind that folder's routes
 * has the SAME resolved plane. A route linked to an unresolved model, or
 * to two models on different planes, gets `hintPlane: null` — an owner
 * question with no hint is still answerable, and a wrong hint is not.
 */
import { compareStrings, loadConfig, type DetectorOutput } from '@gate-forge/core';
import { isTestSourcePath, type SqlalchemyPlane } from '@gate-forge/pack-sqlalchemy';
import { compileEndpointContribution, type EndpointCompilerOptions } from './endpoint-compiler.js';
import { expandScanPaths } from './glob.js';
import { hostDiscoverContext, runPlugins } from './plugins.js';
import { gitIgnoredPaths } from './git-ignored.js';
import { loadOwnerAnswers } from './owner-answers.js';
import { HTTP_ENDPOINT_RESOURCE_KIND } from '@gate-forge/core';

/** The plane values a fact can carry (never inferred, only read). */
const PLANES: readonly SqlalchemyPlane[] = ['tenant', 'master', 'global'];

/** One compiled endpoint, reduced to what a folder question needs. */
export interface RoutePlaneFact {
  /** Repo-relative source file of the SERVER ROUTE that declares it. */
  readonly source: string;
  /** Plane already resolved for the endpoint, or null when unresolved. */
  readonly plane: SqlalchemyPlane | null;
  /** Business model this endpoint is LINKED to, or null when unlinked. */
  readonly linkedResourceName: string | null;
  /**
   * The linked model's OWN resolved plane, or null when the model has
   * none. This is the ONLY thing that may become a hint.
   */
  readonly linkedModelPlane: SqlalchemyPlane | null;
}

/** One folder's plane question. Never an applied answer. */
export interface RouteFolderPlaneProposal {
  /** Repo-relative directory the rule would target, e.g. 'backend/api/v1'. */
  readonly folder: string;
  /** How many plane-unresolved endpoints live in that folder. */
  readonly routeCount: number;
  /** HINT ONLY — never applied, never written by this module. */
  readonly hintPlane: SqlalchemyPlane | null;
  /** Linked model names behind the folder's routes (sorted). */
  readonly linkedModels: readonly string[];
}

/** The plane of a resource's `plane` attribute, or null. */
function planeOf(attributes: Readonly<Record<string, unknown>>): SqlalchemyPlane | null {
  const plane = attributes['plane'];
  return PLANES.find((candidate) => candidate === plane) ?? null;
}

/** The directory of a repo-relative source path ('' at the repository root). */
function directoryOf(source: string): string {
  const index = source.lastIndexOf('/');
  return index === -1 ? '' : source.slice(0, index);
}

/**
 * The single plane every named business resource agrees on, or null when
 * they disagree, are missing, or resolve to nothing. Endpoint resources are
 * never consulted — a route never inherits a plane from another route.
 */
function agreedBusinessPlane(
  name: string,
  business: ReadonlyMap<string, ReadonlySet<SqlalchemyPlane>>,
): SqlalchemyPlane | null {
  const planes = business.get(name);
  if (planes === undefined || planes.size !== 1) return null;
  const [only] = [...planes];
  return only ?? null;
}

/**
 * Runs the repository's discovery and reduces it to route-plane facts.
 *
 * Args:
 *   cwd: Repository root (the `.gateforge.yml` location).
 *
 * Returns:
 *   Promise<RoutePlaneFact[]>: one fact per compiled endpoint, sorted by
 *     source path then identity. Empty when no endpoint was compiled.
 *
 * Raises:
 *   Error: propagates whatever discovery raises (unreadable config, a
 *     failing plugin, a malformed planes document). The caller surfaces
 *     it — a proposal pass must never look like "nothing to ask".
 *
 * The DETECTOR-INPUT scope is the SCAN scope (owner decision D5), not
 * the identity walk: a gitignored, untracked tree (a built report
 * bundle, a local cache) holds no route the owner would ever be asked
 * about, and every other detector-input caller in `init` and in the
 * pipeline enumerates the same list. Outside a git work tree the
 * scope reports `known: false` and skips nothing, so behaviour there
 * is unchanged.
 */
export async function collectRoutePlaneFacts(cwd: string): Promise<RoutePlaneFact[]> {
  const config = loadConfig(`${cwd}/.gateforge.yml`);
  const paths = expandScanPaths(
    config.project.paths.include,
    config.project.paths.exclude,
    cwd,
    gitIgnoredPaths(cwd),
  );
  // 0.11.0: the owner's sections are read ONCE, here, and handed to the
  // detectors and to the endpoint compiler. Reading the answers document
  // in two places is how the proposal pass and the run it proposes for
  // would drift apart, and a proposal that disagrees with its own run is
  // worse than no proposal.
  const answers = loadOwnerAnswers(cwd, config);
  const sections: EndpointCompilerOptions = {
    planes: answers.planes,
    endpoints: answers.endpoints,
    deleteRules: answers.deleteRules,
  };
  const { contributions } = await runPlugins(
    config.plugins,
    paths,
    hostDiscoverContext(cwd, {
      planes: answers.planes,
      endpoints: answers.endpoints,
      httpClients: config.scan.httpClients,
      fastapi: config.scan.fastapi,
      pages: config.pages,
    }),
  );
  return routePlaneFactsOf(contributions, sections);
}

/**
 * Reduces detector contributions to route-plane facts. Pure over its
 * inputs, including the owner sections (0.11.0: the already-parsed
 * `planes:` / `endpoints:` / `deleteRules` the host read).
 *
 * @param contributions - Every configured plugin's discovery output.
 * @param sections - The owner's already-parsed sections; absent = the
 *   repository declares none, which is what an empty document means.
 * @returns One fact per compiled endpoint, sorted and deduplicated.
 */
export function routePlaneFactsOf(
  contributions: readonly DetectorOutput[],
  sections: EndpointCompilerOptions = {},
): RoutePlaneFact[] {
  // Plane evidence per BUSINESS resource name (endpoints excluded): the
  // same view the endpoint compiler and the classifier both read.
  const business = new Map<string, Set<SqlalchemyPlane>>();
  for (const contribution of contributions) {
    for (const resource of contribution.resources) {
      if (resource.kind === HTTP_ENDPOINT_RESOURCE_KIND) continue;
      const name = resource.attributes['resourceName'];
      if (typeof name !== 'string' || name.length === 0) continue;
      const plane = planeOf(resource.attributes);
      if (plane === null) continue;
      const planes = business.get(name);
      if (planes === undefined) business.set(name, new Set([plane]));
      else planes.add(plane);
    }
  }
  const compiled = compileEndpointContribution(contributions, sections);
  // Every plane assertion the compiler minted, keyed by endpoint name. A
  // name with disagreeing assertions resolves to nothing.
  const asserted = new Map<string, Set<SqlalchemyPlane>>();
  for (const signal of compiled.contribution.classificationSignals) {
    if (signal.dimension !== 'plane') continue;
    const name = signal.target.resourceName;
    if (name === undefined) continue;
    if (typeof signal.assertion !== 'string') continue;
    const plane = PLANES.find((candidate) => candidate === signal.assertion);
    if (plane === undefined) continue;
    const planes = asserted.get(name);
    if (planes === undefined) asserted.set(name, new Set([plane]));
    else planes.add(plane);
  }

  const facts: RoutePlaneFact[] = [];
  for (const endpoint of compiled.inventory.endpoints) {
    const source = endpoint.routes[0]?.source.file ?? '';
    if (source.length === 0 || source === '<unknown>' || isTestSourcePath(source)) continue;
    const planes = asserted.get(endpoint.resourceName);
    const linked = endpoint.linkedResourceName;
    facts.push({
      source,
      plane: planes !== undefined && planes.size === 1 ? ([...planes][0] ?? null) : null,
      linkedResourceName: linked,
      linkedModelPlane:
        linked === null ? null : agreedBusinessPlane(linked, business),
    });
  }
  facts.sort(
    (left, right) => compareStrings(left.source, right.source) || compareStrings(left.plane ?? '', right.plane ?? ''),
  );
  return facts;
}

/**
 * Groups plane-unresolved endpoints into one proposal per route folder.
 *
 * Pure: no filesystem, no clock, no writes. The caller owns consent and
 * the write (init asks the owner, then writes one `match: '<folder>/**'`
 * rule per answered folder).
 *
 * @param facts - Route-plane facts from {@link collectRoutePlaneFacts}.
 * @returns One proposal per folder holding unresolved routes, sorted by
 *   folder; `[]` when there is nothing to ask.
 */
export function proposeRouteFolderPlanes(
  facts: readonly RoutePlaneFact[],
): RouteFolderPlaneProposal[] {
  interface Folder {
    count: number;
    /** Linked model name → that model's own resolved plane (or null). */
    models: Map<string, SqlalchemyPlane | null>;
  }
  const folders = new Map<string, Folder>();
  for (const fact of facts) {
    // An endpoint that already HAS a plane is answered; never re-ask.
    if (fact.plane !== null) continue;
    const folder = directoryOf(fact.source);
    // A route declared at the repository root has no folder to target, and
    // a folder rule would sweep in unrelated files. It stays a per-file
    // `classify plane <file>` answer.
    if (folder.length === 0) continue;
    const entry = folders.get(folder);
    if (entry === undefined) {
      folders.set(folder, {
        count: 1,
        models: new Map(
          fact.linkedResourceName === null
            ? []
            : [[fact.linkedResourceName, fact.linkedModelPlane]],
        ),
      });
      continue;
    }
    entry.count += 1;
    if (fact.linkedResourceName !== null) {
      entry.models.set(fact.linkedResourceName, fact.linkedModelPlane);
    }
  }
  return [...folders.keys()]
    .sort(compareStrings)
    .map((folder) => {
      const entry = folders.get(folder);
      const models = entry?.models ?? new Map<string, SqlalchemyPlane | null>();
      const planes = new Set([...models.values()].filter((plane) => plane !== null));
      // The hint is shown only when every linked model behind this folder
      // agrees on ONE resolved plane. No links, an unresolved link, or two
      // planes mean no hint at all — the owner answers from the routes.
      const hintPlane =
        models.size > 0 && planes.size === 1 && [...models.values()].every((plane) => plane !== null)
          ? ([...planes][0] ?? null)
          : null;
      return {
        folder,
        routeCount: entry?.count ?? 0,
        hintPlane,
        linkedModels: [...models.keys()].sort(compareStrings),
      };
    });
}