/**
 * Trusted fixture/actor provider (plan 2026-09-19 §4.5): the ONLY source
 * of fixture namespaces, authoritative subject identities, and actor
 * credentials for strong behavior cases. Loaded ONLY from the approved
 * engine-owned bundle — never from suite-supplied callbacks, never from
 * `AdapterContext.get` or `probeServer`.
 *
 * - `prepare` mints a fresh isolated lease per case (unique namespace);
 *   sequence steps share only their own case lease.
 * - Actor material resolves privately inside the controller/engine
 *   request driver. Cookie/header bytes never appear in suite-visible
 *   results, signed public reports, argv, or logs — the lease carries a
 *   `credentialRef` (an engine-side handle), never token bytes.
 * - `release` cleans the lease namespace; cleanup runs on errors without
 *   flipping the case verdict to success.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** One leased actor: identity/tenant/roles plus a private credential handle. */
export interface ActorLease {
  /** Stable principal id within the fixture recipe. */
  principalId: string;
  /** Owning tenant, or null for tenant-less principals. */
  tenantId: string | null;
  /** Role names the actor holds for this lease. */
  roles: string[];
  /**
   * Private engine-side credential reference (opaque handle). NEVER token
   * bytes, NEVER suite-visible.
   */
  credentialRef: string;
}

/** One isolated fixture lease for a single required case. */
export interface FixtureLease {
  /** Witness-issued lease id (UUID). */
  leaseId: string;
  /** Unique isolated namespace for this case execution. */
  namespace: string;
  /** Authoritative generated subject identities, keyed by recipe name. */
  subjects: Record<string, unknown>;
  /** Leased actors, keyed by recipe profile name. */
  actors: Record<string, ActorLease>;
}

/** Input to {@link FixtureProvider.prepare}. */
export interface FixturePrepareInput {
  /** Approved fixture recipe key (never a suite-supplied callback). */
  recipe: string;
  /** Run id the lease belongs to. */
  runId: string;
  /** Required case id the lease belongs to. */
  caseId: string;
}

/** Engine-side credential material (never suite-visible, never logged). */
export interface CredentialMaterial {
  /** Headers the engine driver attaches to the principal request. */
  headers: Record<string, string>;
}

/** Trusted fixture/actor provider interface. */
export interface FixtureProvider {
  /** Mints a fresh isolated lease for one required case. */
  prepare(input: FixturePrepareInput): Promise<FixtureLease> | FixtureLease;
  /** Releases a lease namespace (idempotent; errors never flip verdicts). */
  release(leaseId: string): Promise<void> | void;
  /**
   * Resolves a lease credentialRef to request material, engine-side
   * only. Returns null for unknown/expired references. The bytes never
   * leave the controller/engine boundary.
   */
  resolveCredential?(credentialRef: string): Promise<CredentialMaterial | null> | CredentialMaterial | null;
}

/**
 * Loads the approved fixture provider from the engine-owned bundle
 * directory (a `fixture-provider.mjs` default export implementing the
 * interface). Returns null when the bundle provides none — strong cases
 * then block with a missing-provider cause instead of falling back to
 * suite-supplied fixtures.
 *
 * Args:
 *   bundleDir: absolute engine-owned bundle directory, or null.
 *
 * Returns:
 *   Promise<FixtureProvider | null>: the approved provider or null.
 *
 * Throws:
 *   Error: when the module exists but does not implement the interface
 *   (fail closed — a half-shaped provider is never used).
 */
export async function loadFixtureProvider(bundleDir: string | null): Promise<FixtureProvider | null> {
  if (bundleDir === null) return null;
  const entry = join(bundleDir, 'fixture-provider.mjs');
  if (!existsSync(entry)) return null;
  const module = (await import(pathToFileURL(entry).href)) as { default?: unknown };
  const provider = module.default as Partial<FixtureProvider> | undefined;
  if (
    provider === undefined ||
    typeof provider.prepare !== 'function' ||
    typeof provider.release !== 'function'
  ) {
    throw new Error(
      'approved fixture provider is malformed: default export must implement {prepare, release} (fail closed)',
    );
  }
  return provider as FixtureProvider;
}

/** In-memory provider for witness tests (engine-side only, never a worker API). */
export function createMemoryFixtureProvider(options: {
  /** Actor profiles available to recipes: profile name → lease template. */
  actors?: Record<string, { principalId: string; tenantId: string | null; roles: string[] }>;
  /** Engine-side credential headers per actor profile (test secrets, never suite-visible). */
  credentials?: Record<string, Record<string, string>>;
  /** Fixture subjects per recipe: recipe name → subject key → value. */
  subjects?: Record<string, Record<string, unknown>>;
} = {}): FixtureProvider & { leases(): FixtureLease[] } {
  const live = new Map<string, FixtureLease>();
  let counter = 0;
  const actors = options.actors ?? {};
  const credentials = options.credentials ?? {};
  const subjects = options.subjects ?? {};
  const credentialFor = (credentialRef: string): CredentialMaterial | null => {
    const match = /^credref:([^:]+):(.+)$/.exec(credentialRef);
    if (match === null) return null;
    const profile = match[2] as string;
    if (!live.has(match[1] as string)) return null;
    const headers = credentials[profile];
    if (headers === undefined) return null;
    return { headers: { ...headers } };
  };
  return {
    prepare(input: FixturePrepareInput): FixtureLease {
      counter += 1;
      const leaseId = randomUUID();
      const namespace = `fixture-${input.runId}-${input.caseId}-${String(counter)}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-');
      const leasedActors: Record<string, ActorLease> = {};
      for (const [name, template] of Object.entries(actors)) {
        leasedActors[name] = {
          principalId: template.principalId,
          tenantId: template.tenantId,
          roles: [...template.roles],
          credentialRef: `credref:${leaseId}:${name}`,
        };
      }
      const recipeSubjects = subjects[input.recipe];
      const lease: FixtureLease = {
        leaseId,
        namespace,
        subjects: recipeSubjects === undefined ? {} : JSON.parse(JSON.stringify(recipeSubjects)) as Record<string, unknown>,
        actors: leasedActors,
      };
      live.set(leaseId, lease);
      return lease;
    },
    release(leaseId: string): void {
      live.delete(leaseId);
    },
    resolveCredential(credentialRef: string): CredentialMaterial | null {
      return credentialFor(credentialRef);
    },
    leases(): FixtureLease[] {
      return [...live.values()];
    },
  };
}
