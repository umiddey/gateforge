/**
 * Twin path coverage (E64): the pure half — what a request shape may
 * contain, and what two twins disagree about.
 *
 * The bug this exists for is a GREEN one: a raw test and its witnessed
 * twin shared a helper whose defaults sent them down different paths, so
 * three green runs proved nothing about the path the witnessed twin
 * covered and nothing said so.
 */
import { describe, expect, it } from 'vitest';
import {
  twinDivergenceDetail,
  twinLinksFor,
  twinPathDivergence,
  twinShapeOf,
  type TwinCandidate,
  type TwinShape,
} from '../src/twin-paths.js';

const INVENTORY = { templates: ['/api/accounts', '/api/accounts/{}'] };

describe('twin request shapes', () => {
  it('records method, route template and the allowlisted query values', () => {
    expect(twinShapeOf({ method: 'get', url: '/api/accounts?tab=open&page=2' }, { inventory: INVENTORY, queryKeys: ['tab'] })).toEqual({
      method: 'GET',
      route: '/api/accounts',
      query: { tab: 'open' },
    });
  });

  it('never carries a concrete identifier: the route resolves to its template', () => {
    expect(twinShapeOf({ method: 'GET', url: '/api/accounts/acc-42' }, { inventory: INVENTORY }).route).toBe('/api/accounts/{}');
    // With no inventory to resolve against, a numeric or UUID segment is
    // still an identifier and is still replaced.
    expect(twinShapeOf({ method: 'GET', url: '/api/accounts/42' }).route).toBe('/api/accounts/{}');
    expect(twinShapeOf({ method: 'GET', url: '/api/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301' }).route).toBe(
      '/api/orders/{}',
    );
  });

  it('records the KEY of a query parameter whose value the owner did not allowlist, and never its value', () => {
    const shape = twinShapeOf({ method: 'GET', url: '/api/accounts?tab=open&token=s3cr3t-value' }, {
      inventory: INVENTORY,
      queryKeys: [],
    });
    expect(shape.query).toBeUndefined();
    // The key is what a divergence can still talk about; the value is
    // nowhere in the shape.
    expect(JSON.stringify(shape)).not.toContain('s3cr3t');
    expect(twinShapeOf({ method: 'GET', url: '/api/accounts?token=s3cr3t-value' }).route).toBe('/api/accounts');
  });
});

describe('twin path divergence', () => {
  const witnessed = (url: string): TwinShape =>
    twinShapeOf({ method: 'GET', url }, { inventory: INVENTORY, queryKeys: ['tab'] });

  it('names the exact differing query value when the twins defaulted differently', () => {
    const divergence = twinPathDivergence(
      { logicalKey: 'specs/list.spec.js#lists open items [witnessed]', shapes: [witnessed('/api/accounts?tab=open')] },
      { logicalKey: 'specs/list.spec.js#lists open items raw', shapes: [witnessed('/api/accounts?tab=all')] },
    );
    expect(divergence).toHaveLength(2);
    const details = divergence.map(twinDivergenceDetail);
    expect(details[0]).toContain('tab=open');
    expect(details[0]).toContain("'specs/list.spec.js#lists open items [witnessed]'");
    expect(details[0]).toContain("'specs/list.spec.js#lists open items raw'");
    expect(details[1]).toContain('tab=all');
  });

  it('finds nothing when the twins exercised the same shapes', () => {
    const shapes = [witnessed('/api/accounts?tab=open'), twinShapeOf({ method: 'POST', url: '/api/accounts' })];
    expect(
      twinPathDivergence({ logicalKey: 'a#witnessed', shapes }, { logicalKey: 'a#raw', shapes: [...shapes] }),
    ).toEqual([]);
  });

  it('reports only the one-sided shapes, in both directions', () => {
    const divergence = twinPathDivergence(
      {
        logicalKey: 'a#witnessed',
        shapes: [witnessed('/api/accounts?tab=open'), witnessed('/api/accounts/7')],
      },
      { logicalKey: 'a#raw', shapes: [witnessed('/api/accounts?tab=open')] },
    );
    expect(divergence).toHaveLength(1);
    expect(divergence[0]?.presentIn).toBe('a#witnessed');
    expect(divergence[0]?.missingFrom).toBe('a#raw');
    expect(divergence[0]?.shape.route).toBe('/api/accounts/{}');
  });

  it('treats a repeated request as one shape', () => {
    const shape = witnessed('/api/accounts?tab=open');
    expect(
      twinPathDivergence({ logicalKey: 'a#witnessed', shapes: [shape, shape] }, { logicalKey: 'a#raw', shapes: [shape] }),
    ).toEqual([]);
  });

  it('keeps a non-allowlisted value out of the finding text as well', () => {
    const divergence = twinPathDivergence(
      {
        logicalKey: 'a#witnessed',
        shapes: [twinShapeOf({ method: 'GET', url: '/api/accounts?token=abc123' }, { inventory: INVENTORY })],
      },
      { logicalKey: 'a#raw', shapes: [] },
    );
    expect(twinDivergenceDetail(divergence[0] as never)).not.toContain('abc123');
    expect(twinDivergenceDetail(divergence[0] as never)).toContain('/api/accounts');
  });
});

describe('twin links', () => {
  /** The catalog a link resolves against: logical key + the test's own title. */
  const catalog = (...rows: readonly [string, string][]): TwinCandidate[] =>
    rows.map(([logicalKey, title]) => ({ logicalKey, title }));

  it('links an explicit `twinOf` declaration, which survives a rename of either title', () => {
    const candidates = catalog(
      ['k-witnessed', 'lists the open items through the rendered UI'],
      ['k-raw', 'lists the open items fast, without the witness'],
    );
    expect(twinLinksFor(candidates, { 'k-witnessed': 'k-raw' })).toEqual([
      { witnessed: 'k-witnessed', raw: 'k-raw', source: 'test-map' },
    ]);
    // The declaration names the graded test, so a repository that spells
    // the same pair out twice gets exactly one link, and the explicit
    // rule owns it even when the titles would link it too.
    expect(
      twinLinksFor(
        catalog(
          ['k-witnessed', 'lists the open items [witnessed]'],
          ['k-raw', 'lists the open items raw'],
        ),
        { 'k-witnessed': 'k-raw' },
      ),
    ).toEqual([{ witnessed: 'k-witnessed', raw: 'k-raw', source: 'test-map' }]);
  });

  it('links the title convention, preferring the explicit `raw` partner over a bare one', () => {
    const candidates = catalog(
      ['k-witnessed', 'lists the open items [witnessed]'],
      ['k-raw', 'lists the open items raw'],
      ['k-bare', 'lists the open items'],
    );
    expect(twinLinksFor(candidates)).toEqual([
      { witnessed: 'k-witnessed', raw: 'k-raw', source: 'title' },
    ]);
    // Without a `raw` partner the bare title is the owner's convention
    // for the same pair.
    expect(twinLinksFor(candidates.filter((candidate) => candidate.logicalKey !== 'k-raw'))).toEqual([
      { witnessed: 'k-witnessed', raw: 'k-bare', source: 'title' },
    ]);
  });

  it('names nothing when either side is missing, rather than a ghost pair', () => {
    const candidates = catalog(['k-witnessed', 'lists the open items [witnessed]']);
    // A dangling `twinOf`: the raw twin is not in the catalog.
    expect(twinLinksFor(candidates, { 'k-witnessed': 'k-gone' })).toEqual([]);
    // A dangling title: no partner carries the untagged stem.
    expect(twinLinksFor(candidates)).toEqual([]);
    // A self-link is not a pair either.
    expect(twinLinksFor(candidates, { 'k-witnessed': 'k-witnessed' })).toEqual([]);
  });

  it('leaves a contested bare title to one witnessed twin instead of guessing twice', () => {
    const candidates = catalog(
      ['a-witnessed', 'lists the open items [witnessed]'],
      ['b-witnessed', 'lists the open items [witnessed] too'],
      ['k-raw', 'lists the open items'],
    );
    // Both stems are `lists the open items`, so both would claim the
    // one bare raw test. The first key (sorted) owns it; the other names
    // nothing rather than reporting a pair the owner never described.
    expect(twinLinksFor(candidates)).toEqual([
      { witnessed: 'a-witnessed', raw: 'k-raw', source: 'title' },
    ]);
  });

  it('never pairs a witnessed title with another witnessed title', () => {
    const candidates = catalog(['k-a', 'lists the open items [witnessed]'], ['k-b', 'lists the open items [witnessed]']);
    expect(twinLinksFor(candidates)).toEqual([]);
  });
});
