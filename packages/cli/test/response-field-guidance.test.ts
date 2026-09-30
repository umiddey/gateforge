/**
 * The frontend-read / response-model gap advisory (plan 2026-09-25 Phase
 * 4b item 5).
 *
 * A merge request once shipped a frontend that read `invoice.dueDate`
 * while the FastAPI response model had dropped that field: every test
 * mocked or tolerated `undefined` and the screen showed nothing. pack-http
 * collects the fields a call site reads, pack-fastapi reports the wire
 * names its response model answers to, and the endpoint compiler joins
 * them; `check` must then say so in ONE advisory naming the endpoint,
 * the field and the reading line. The advisory NEVER blocks, and a
 * repository whose facts carry no response model yields nothing at all
 * (byte-identical report).
 */
import { describe, expect, it } from 'vitest';
import { renderRun, runExitCode } from '@gate-forge/core';
import type { HttpContractFact, HttpLocation, HttpMethod } from '@gate-forge/http-contract';
import {
  responseFieldAdvisories,
  responseFieldGaps,
  type ResponseFieldEndpoint,
} from '../src/response-field-guidance.js';
import { compileEndpointContribution } from '../src/endpoint-compiler.js';

/** One source location triple. */
function at(file: string, line: number): HttpLocation {
  return { file, line, col: 4 };
}
/** One source location triple. */

/** One server-route fact of a joined endpoint. */
function route(fields?: readonly string[], overrides: Partial<HttpContractFact> = {}): HttpContractFact {
  return {
    schemaVersion: 1,
    role: 'server-route',
    method: 'GET',
    normalizedPath: '/invoices/{}',
    rawPath: '/invoices/${id}',
    framework: 'fastapi',
    source: at('backend/api/routes/invoices.py', 20),
    ...(fields === undefined ? {} : { responseModelFields: [...fields] }),
    ...overrides,
  };
}

/** One frontend-call fact of a joined endpoint, with its field reads. */
function call(
  reads: ReadonlyArray<{ field: string; location: HttpLocation; chain?: number }>,
  overrides: Partial<HttpContractFact> = {},
): HttpContractFact {
  return {
    schemaVersion: 1,
    role: 'frontend-call',
    method: 'GET',
    normalizedPath: '/invoices/{}',
    rawPath: '/invoices/${id}',
    framework: 'axios',
    source: at('frontend/src/invoices.ts', 40),
    responseReads: reads.map((read) => ({ ...read })),
    ...overrides,
  };
}

/** One joined endpoint (what the endpoint compiler hands over). */
function endpoint(
  routes: readonly HttpContractFact[],
  calls: readonly HttpContractFact[],
  method: HttpMethod = 'GET',
  canonicalPath = '/invoices/{}',
): ResponseFieldEndpoint {
  return {
    identity: `${method} ${canonicalPath}`,
    method,
    canonicalPath,
    routes,
    calls,
  };
}

describe('response-field advisory', () => {
  it('names the endpoint, the field and the reading line', () => {
    const [entry] = responseFieldAdvisories([
      endpoint(
        [route(['id', 'total', 'status'])],
        [call([{ field: 'dueDate', location: at('frontend/src/invoices.ts', 42) }])],
      ),
    ]);
    expect(entry?.kind).toBe('finding');
    expect(entry?.cause).toBe('RESPONSE_FIELD_MISSING_FROM_MODEL');
    expect(entry?.detail).toContain('GET /invoices/{}');
    expect(entry?.detail).toContain("'dueDate'");
    expect(entry?.detail).toContain('id, total, status');
    expect(entry?.location).toEqual(at('frontend/src/invoices.ts', 42));
    expect(entry?.nextAction).toContain('response model');
  });

  it('says nothing for a field the model answers to (exact, snake/camel, alias)', () => {
    const snake = [{ field: 'due_date', location: at('frontend/src/invoices.ts', 42) }];
    const camel = [{ field: 'dueDate', location: at('frontend/src/invoices.ts', 43) }];
    const aliased = [{ field: 'invoiceDueDate', location: at('frontend/src/invoices.ts', 44) }];
    const cases: Array<{ declared: readonly string[]; read: typeof snake; gap?: boolean }> = [
      { declared: ['id', 'due_date'], read: snake },            // the model declares the snake field
      { declared: ['id', 'dueDate'], read: camel },             // the model declares the camel field
      { declared: ['id', 'dueDate', 'due_date'], read: [...snake, ...camel] }, // both spellings on the wire
      // A declared alias IS the wire name, so reading it is fine …
      { declared: ['id', 'invoiceDueDate'], read: aliased },
      // … while reading the field name behind that alias is the drift
      // this advisory exists to name.
      { declared: ['id', 'invoiceDueDate'], read: camel, gap: true },
    ];
    for (const { declared, read, gap = false } of cases) {
      expect(responseFieldGaps([endpoint([route(declared)], [call(read)])])).toEqual(
        gap ? [expect.objectContaining({ field: camel[0]?.field })] : [],
      );
    }
  });

  it('is byte-identical for a repository without both packs or without a response model', () => {
    // No pack-http facts at all (a repository with no frontend), no
    // pack-fastapi facts at all, and a joined call whose route declares no
    // response model: all three produce no entry, so the report keeps the
    // exact bytes it had before the check existed.
    const withoutBothPacks: ResponseFieldEndpoint[] = [];
    const withoutResponseModel = [
      endpoint([route(undefined)], [call([{ field: 'dueDate', location: at('frontend/src/invoices.ts', 42) }])]),
    ];
    expect(responseFieldAdvisories(withoutBothPacks)).toEqual([]);
    expect(responseFieldAdvisories(withoutResponseModel)).toEqual([]);
    const base = { format: 'text' as const };
    const withoutAdvisories = renderRun([], base);
    expect(renderRun([], { ...base, advisories: responseFieldAdvisories(withoutBothPacks) })).toBe(
      withoutAdvisories,
    );
    expect(
      renderRun([], { ...base, advisories: responseFieldAdvisories(withoutResponseModel) }),
    ).toBe(withoutAdvisories);
    const jsonBase = { format: 'json' as const };
    expect(
      renderRun([], { ...jsonBase, advisories: responseFieldAdvisories(withoutResponseModel) }),
    ).toBe(renderRun([], jsonBase));
  });

  it('never changes the exit code: the finding rides the advisory channel', () => {
    const advisories = responseFieldAdvisories([
      endpoint([route(['id'])], [call([{ field: 'dueDate', location: at('frontend/src/invoices.ts', 42) }])]),
    ]);
    expect(advisories).toHaveLength(1);
    // The exit code is computed over verdicts and BLOCKING entries only;
    // the advisory is in neither, and it is rendered as an advisory.
    expect(runExitCode({ verdicts: [], blocking: [] })).toBe(0);
    const text = renderRun([], { format: 'text', advisories });
    expect(text).toContain('advisories (non-blocking):');
    const json = JSON.parse(renderRun([], { format: 'json', advisories })) as {
      blocking?: unknown;
      advisories: Array<{ cause: string }>;
    };
    expect(json.blocking).toEqual([]);
    expect(json.advisories).toHaveLength(1);
    expect(json.advisories[0]?.cause).toBe('RESPONSE_FIELD_MISSING_FROM_MODEL');
  });

  it('stays silent when a call resolves to no route, or carries no proven read', () => {
    // Unwired call: no endpoint carries it, so no route declares fields.
    expect(
      responseFieldGaps([endpoint([route(['id'])], [])]),
    ).toEqual([]);
    // A call that reads nothing proves nothing.
    expect(responseFieldGaps([endpoint([route(['id'])], [call([])])])).toEqual([]);
  });

  it('reports every distinct gap once, in a deterministic order', () => {
    const gaps = responseFieldGaps([
      endpoint(
        [route(['id'])],
        [
          call([
            { field: 'dueDate', location: at('frontend/src/invoices.ts', 42) },
            { field: 'dueDate', location: at('frontend/src/invoices.ts', 42) },
            { field: 'paidAt', location: at('frontend/src/invoices.ts', 51) },
          ]),
        ],
      ),
      endpoint([route(['id'])], [call([{ field: 'ref', location: at('frontend/src/invoices.ts', 7) }])], 'GET', '/refs/{}'),
    ]);
    expect(gaps.map((gap) => `${gap.identity} ${gap.field} ${gap.location.file}:${gap.location.line}`)).toEqual([
      'GET /invoices/{} dueDate frontend/src/invoices.ts:42',
      'GET /invoices/{} paidAt frontend/src/invoices.ts:51',
      'GET /refs/{} ref frontend/src/invoices.ts:7',
    ]);
  });

  it('ignores a malformed read instead of crashing the gate', () => {
    const malformed = [
      call([{ field: '', location: at('frontend/src/invoices.ts', 42) }]),
      call([{ field: 'dueDate', location: { file: '', line: 1, col: 0 } }]),
      call([{ field: 7 as unknown as string, location: at('frontend/src/invoices.ts', 42) }]),
    ];
    for (const facts of malformed) {
      expect(responseFieldGaps([endpoint([route(['id'])], [facts])])).toEqual([]);
    }
  });

  it('treats the operands of a fallback chain as one read of the same result', () => {
    // `res.data?.invoice_id || res.data?.invoice?.id` — the model declares
    // `invoice_id`, so the second operand is the defensive fallback and
    // no field is missing.
    const chain = [
      { field: 'invoice_id', location: at('frontend/src/invoices.ts', 42), chain: 0 },
      { field: 'invoice', location: at('frontend/src/invoices.ts', 42), chain: 0 },
    ];
    expect(responseFieldGaps([endpoint([route(['id', 'invoice_id'])], [call(chain)])])).toEqual([]);
    // A chain in which NO operand is declared drops every operand: both
    // spellings are unproven, so both are still reported.
    expect(
      responseFieldGaps([endpoint([route(['id'])], [call(chain)])]).map((gap) => gap.field),
    ).toEqual(['invoice', 'invoice_id']);
    // Two independent chains do not excuse each other: only the chain
    // with a declared operand is silent.
    expect(
      responseFieldGaps([
        endpoint([route(['invoice_id'])], [
          call([
            { field: 'invoice_id', location: at('frontend/src/invoices.ts', 42), chain: 0 },
            { field: 'invoice', location: at('frontend/src/invoices.ts', 42), chain: 0 },
            { field: 'paidAt', location: at('frontend/src/invoices.ts', 43), chain: 1 },
            { field: 'settledAt', location: at('frontend/src/invoices.ts', 43), chain: 1 },
          ]),
        ]),
      ]).map((gap) => gap.field),
    ).toEqual(['paidAt', 'settledAt']);
    // An unchained read is never a fallback, however a sibling reads.
    expect(
      responseFieldGaps([
        endpoint([route(['id'])], [
          call([
            { field: 'invoice_id', location: at('frontend/src/invoices.ts', 42) },
            { field: 'invoice', location: at('frontend/src/invoices.ts', 43) },
          ]),
        ]),
      ]).map((gap) => gap.field),
    ).toEqual(['invoice_id', 'invoice']);
  });

  it('finds the gap through the real endpoint join, not just hand-built facts', () => {
    // The wire shape the two packs actually emit: pack-http's
    // frontend-call resource (with `responseReads`) and pack-fastapi's
    // server-route resource (with `responseModelFields`), joined by the
    // endpoint compiler exactly as a `check` run does it.
    const contribution = (detectorId: string, resource: Record<string, unknown>) => ({
      detectorId,
      detectorVersion: '1',
      resources: [resource],
      unresolved: [],
      findings: [],
      classificationSignals: [],
      scannedPaths: [],
    });
    const { inventory } = compileEndpointContribution([
      contribution('gateforge.pack-fastapi', {
        schemaVersion: 1,
        id: 'http.contract:backend/api/routes/invoices.py:read_invoice:GET:/invoices/{invoice_id}',
        kind: 'http.contract',
        source: 'backend/api/routes/invoices.py',
        location: { file: 'backend/api/routes/invoices.py', line: 12, col: 0 },
        detectorVersion: '0.1.0',
        attributes: {
          role: 'server-route',
          method: 'GET',
          rawPath: '/invoices/{invoice_id}',
          effectivePath: '/invoices/{invoice_id}',
          normalizedPath: '/invoices/{}',
          framework: 'fastapi',
          responseModelFields: ['amount_cents', 'currency', 'id', 'invoiceDueDate', 'due_date'],
        },
      }),
      contribution('gateforge.pack-http', {
        schemaVersion: 1,
        id: 'http.contract:frontend/src/invoices.ts:42:0',
        kind: 'http.contract',
        source: 'frontend/src/invoices.ts',
        location: { file: 'frontend/src/invoices.ts', line: 42, col: 0 },
        detectorVersion: '0.1.0',
        attributes: {
          role: 'frontend-call',
          method: 'GET',
          rawPath: '/invoices/${id}',
          normalizedPath: '/invoices/{}',
          framework: 'apiClient',
          responseReads: [
            // Declared (snake form) and declared (exact): no advisory.
            { field: 'due_date', location: { file: 'frontend/src/invoices.ts', line: 44, col: 12 } },
            { field: 'id', location: { file: 'frontend/src/invoices.ts', line: 45, col: 12 } },
            // The model dropped it: the one advisory.
            { field: 'paidAt', location: { file: 'frontend/src/invoices.ts', line: 46, col: 12 } },
          ],
        },
      }),
    ] as never);
    const [entry] = responseFieldAdvisories(inventory.endpoints);
    expect(entry?.cause).toBe('RESPONSE_FIELD_MISSING_FROM_MODEL');
    // `due_date` (and its alias `invoiceDueDate`) is on the wire, so the
    // only entry names the field the model no longer declares.
    expect(entry?.detail).toContain('GET /invoices/{}');
    expect(entry?.detail).toContain("'paidAt'");
    expect(entry?.location).toEqual({ file: 'frontend/src/invoices.ts', line: 46, col: 12 });
  });
});
