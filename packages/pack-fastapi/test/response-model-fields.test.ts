/**
 * Response-model wire names (plan 2026-09-25 Phase 4b item 5).
 *
 * A dropped response-model field is invisible from the frontend, so the
 * pack reports the names a route's model answers to: the field name, a
 * declared alias, and a provable inherited field. Anything the AST pass
 * cannot compute — an alias generator, an unresolvable base, a union of
 * two models, a `dict` — must carry NO field list at all, because a
 * partial list would make the frontend-read advisory accuse the code of
 * reading a field that is really there.
 */
import { describe, expect, it } from 'vitest';
import { runDetector } from './helpers.js';

interface FactView {
  kind: string;
  attributes: Record<string, unknown>;
}

function contractFacts(resources: readonly unknown[]): FactView[] {
  return resources.filter(
    (resource): resource is FactView =>
      typeof resource === 'object' &&
      resource !== null &&
      (resource as FactView).kind === 'http.contract',
  );
}

/** `<METHOD> <path>` → declared wire names (absent = no field list). */
async function declaredFields(): Promise<Record<string, string[] | undefined>> {
  const outcome = await runDetector(['response_models/routes.py', 'response_models/schemas.py']);
  const fields: Record<string, string[] | undefined> = {};
  for (const fact of contractFacts(outcome.resources)) {
    const key = `${String(fact.attributes['method'])} ${String(fact.attributes['normalizedPath'])}`;
    fields[key] = fact.attributes['responseModelFields'] as string[] | undefined;
  }
  return fields;
}

describe('response model fields', () => {
  it('reports the field name, a declared alias and a provable inherited field', async () => {
    const fields = await declaredFields();
    // The return annotation is FastAPI's own default response model, and
    // `due_date` reaches the wire under its declared alias.
    expect(fields['GET /invoices/{}']).toEqual([
      'amount_cents',
      'currency',
      'id',
      'invoiceDueDate',
      'due_date',
    ]);
    // `list[InvoiceOut]` is the element model, unwrapped exactly as
    // FastAPI unwraps it.
    expect(fields['GET /invoices']).toEqual(fields['GET /invoices/{}']);
    // The decorator's explicit `response_model=` wins over the annotation
    // and yields the very same list.
    expect(fields['POST /invoices']).toEqual(fields['GET /invoices/{}']);
    expect(fields['GET /money']).toEqual(['amount_cents', 'currency']);
    expect(fields['GET /maybe']).toEqual(['amount_cents', 'currency']);
  });

  it('declares nothing at all for a model whose wire names it cannot compute', async () => {
    const fields = await declaredFields();
    // pydantic v2 `model_config` and v1 `class Config` alias generators.
    expect(fields['GET /generated']).toBeUndefined();
    expect(fields['GET /configured']).toBeUndefined();
    // A base class outside the scanned set: inherited fields unknown.
    expect(fields['GET /foreign']).toBeUndefined();
    // Shapes that are not one provable model.
    expect(fields['GET /opaque']).toBeUndefined();
    expect(fields['GET /union']).toBeUndefined();
    expect(fields['GET /unannotated']).toBeUndefined();
  });

  it('leaves the existing responseModel attribute exactly as it was', async () => {
    const outcome = await runDetector(['response_models/routes.py', 'response_models/schemas.py']);
    const byPath = new Map(
      contractFacts(outcome.resources).map((fact) => [
        `${String(fact.attributes['method'])} ${String(fact.attributes['normalizedPath'])}`,
        fact.attributes['responseModel'],
      ]),
    );
    // Only the decorator declaration is reported as `responseModel`; a
    // return annotation is a NEW fact (`responseModelFields`), never a
    // change of the existing attribute.
    expect(byPath.get('POST /invoices')).toBe('InvoiceOut');
    expect(byPath.get('GET /invoices/{}')).toBeNull();
  });
});
