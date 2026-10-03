/**
 * Route-folder plane PROPOSALS (problem 13, owner decision D1: ask, never
 * infer).
 *
 * `gateforge init` used to propose plane rules only for MODEL folders, so
 * every discovered endpoint stayed `PLANE_UNRESOLVED` and every endpoint
 * obligation waited on hand-edited JSON. The proposal now covers ROUTE
 * folders too — one question per folder — and shows the plane of the
 * models those routes link to as a HINT only. Nothing is ever applied
 * without the owner's answer, and a hint is withheld whenever it would be
 * a guess (an unresolved linked model, or two models that disagree).
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { withTempRepo } from '@gate-forge/core';
import type { DetectorOutput } from '@gate-forge/core';
import type { HttpContractFact, HttpMethod } from '@gate-forge/http-contract';
import {
  proposeRouteFolderPlanes,
  routePlaneFactsOf,
  type RoutePlaneFact,
} from '../src/route-plane-proposals.js';

let seq = 500;

/** One server-route contract fact, as a route pack emits it. */
function route(
  method: HttpMethod,
  path: string,
  file: string,
  overrides: Partial<HttpContractFact> = {},
): HttpContractFact {
  seq += 1;
  return {
    schemaVersion: 1,
    role: 'server-route',
    method,
    normalizedPath: path,
    rawPath: path,
    framework: 'fastapi',
    handlerSymbol: `router.list_${seq}`,
    source: { file, line: seq, col: 0 },
    ...overrides,
  };
}

/** Wraps route facts into a detector contribution. */
function routeContribution(facts: readonly HttpContractFact[]): DetectorOutput {
  return {
    detectorId: 'test.routes',
    detectorVersion: '1',
    resources: facts.map((fact, index) => ({
      schemaVersion: 1 as const,
      id: `http.contract:test:${String(index)}`,
      kind: 'http.contract',
      source: fact.source.file,
      location: fact.source,
      detectorVersion: '1',
      attributes: { ...fact } as Record<string, unknown>,
    })),
    unresolved: [],
    findings: [],
    classificationSignals: [],
  } as DetectorOutput;
}

/** A model resource carrying (or not carrying) a resolved plane. */
function model(
  name: string,
  plane: string | null,
): {
  detectorId: string;
  detectorVersion: string;
  resources: Array<{
    schemaVersion: 1;
    id: string;
    kind: string;
    source: string;
    location: { file: string; line: number; col: number };
    detectorVersion: string;
    attributes: Record<string, unknown>;
  }>;
  unresolved: never[];
  findings: never[];
  classificationSignals: never[];
} {
  return {
    detectorId: 'test.models',
    detectorVersion: '1',
    resources: [
      {
        schemaVersion: 1,
        id: `sqlalchemy.table:${name}`,
        kind: 'sqlalchemy.table',
        source: `backend/models/${name}.py`,
        location: { file: `backend/models/${name}.py`, line: 4, col: 0 },
        detectorVersion: '1',
        attributes: { resourceName: name, ...(plane === null ? {} : { plane }) },
      },
    ],
    unresolved: [],
    findings: [],
    classificationSignals: [],
  };
}

/** A fact as the collector would emit it. */
function fact(overrides: Partial<RoutePlaneFact> = {}): RoutePlaneFact {
  return {
    source: 'backend/api/v1/accounts.py',
    plane: null,
    linkedResourceName: 'accounts',
    linkedModelPlane: null,
    ...overrides,
  };
}

describe('route-folder plane proposals (problem 13)', () => {
  it('groups plane-unresolved endpoints by their server-route folder', async () => {
    await withTempRepo({}, async (repo) => {
      const facts = routePlaneFactsOf(
        [
          routeContribution([
            route('GET', '/api/v1/accounts', 'backend/api/v1/accounts.py'),
            route('POST', '/api/v1/accounts', 'backend/api/v1/accounts.py'),
            route('GET', '/api/v1/orders', 'backend/api/v1/orders.py'),
            route('GET', '/ops/health', 'ops/health.py'),
          ]),
          model('accounts', 'tenant') as DetectorOutput,
        ],
        repo.root,
      );
      const proposals = proposeRouteFolderPlanes(facts);
      expect(
        proposals.map((proposal) => [proposal.folder, proposal.routeCount]),
      ).toEqual([
        ['backend/api/v1', 3],
        ['ops', 1],
      ]);
    });
  });

  it('shows the linked models plane as a HINT only', async () => {
    await withTempRepo({}, async (repo) => {
      const facts = routePlaneFactsOf(
        [
          routeContribution([
            route('GET', '/api/v1/accounts', 'backend/api/v1/accounts.py', {
              responseSchemaSymbols: ['AccountOut'],
            }),
          ]),
          model('accounts', 'tenant') as DetectorOutput,
        ],
        repo.root,
      );
      const [proposal] = proposeRouteFolderPlanes(facts);
      expect(proposal?.folder).toBe('backend/api/v1');
      // The hint is evidence the owner reads. The function applies nothing
      // and writes nothing: no planes document exists after the call.
      expect(proposal?.hintPlane).toBe('tenant');
      expect(proposal?.linkedModels).toEqual(['accounts']);
      expect(existsSync(join(repo.root, '.gateforge/planes.json'))).toBe(false);
    });
  });

  it('withholds the hint whenever it would be a guess', () => {
    const unresolved = proposeRouteFolderPlanes([
      fact({ linkedModelPlane: null }),
    ]);
    expect(unresolved).toEqual([
      { folder: 'backend/api/v1', routeCount: 1, hintPlane: null, linkedModels: ['accounts'] },
    ]);

    // Two linked models on different planes: the folder question stays,
    // the hint does not.
    const disagreeing = proposeRouteFolderPlanes([
      fact({ linkedModelPlane: 'tenant' }),
      fact({
        source: 'backend/api/v1/orders.py',
        linkedResourceName: 'orders',
        linkedModelPlane: 'master',
      }),
    ]);
    expect(disagreeing[0]?.routeCount).toBe(2);
    expect(disagreeing[0]?.hintPlane).toBeNull();
    expect(disagreeing[0]?.linkedModels).toEqual(['accounts', 'orders']);

    // A route linked to no model at all is answerable from the routes.
    expect(
      proposeRouteFolderPlanes([
        fact({ linkedResourceName: null, linkedModelPlane: null }),
      ])[0],
    ).toEqual({
      folder: 'backend/api/v1',
      routeCount: 1,
      hintPlane: null,
      linkedModels: [],
    });
  });

  it('never re-asks a folder whose endpoints are already answered', () => {
    expect(
      proposeRouteFolderPlanes([
        fact({ plane: 'tenant' }),
        fact({
          source: 'backend/api/v1/orders.py',
          plane: 'global',
          linkedResourceName: 'orders',
          linkedModelPlane: 'global',
        }),
      ]),
    ).toEqual([]);
    // And nothing at all to ask means an empty proposal, not a guess.
    expect(proposeRouteFolderPlanes([])).toEqual([]);
  });

  it('never proposes a route file that lives under a test directory', async () => {
    await withTempRepo({}, async (repo) => {
      const facts = routePlaneFactsOf(
        [
          routeContribution([
            route('GET', '/api/v1/accounts', 'backend/api/v1/accounts.py'),
            route('GET', '/api/v1/fixtures', 'tests/api/fixtures.py'),
            route('GET', '/api/v1/root-level', 'health.py'),
          ]),
        ],
        repo.root,
      );
      expect(facts.map((entry) => entry.source)).toEqual([
        'backend/api/v1/accounts.py',
        'health.py',
      ]);
      // A file at the repository root has no folder to target, so it is
      // not asked about — it stays a per-file `classify plane` answer.
      expect(proposeRouteFolderPlanes(facts)).toEqual([
        {
          folder: 'backend/api/v1',
          routeCount: 1,
          hintPlane: null,
          linkedModels: [],
        },
      ]);
    });
  });
});