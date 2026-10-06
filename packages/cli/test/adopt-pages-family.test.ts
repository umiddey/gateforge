/**
 * `gateforge adopt --family pages` (0.13): the pages-family migration of
 * an ALREADY-adopted repository — the one owner-approved exception to the
 * one-bulk-add invariant. Preview writes nothing; `--confirm` performs
 * ONE atomic write to the EXISTING receipt (a `families.pages` marker
 * recording every page obligation, proven pages included, with only the
 * then-missing/unproven page fingerprints forgiven); the baseline
 * document is never touched, so no crash window can expose unrecorded
 * forgiveness. The marker is permanent: repeats add nothing, new pages
 * stay new work, a proven page that breaks later blocks, family debt
 * shrinks via `baseline update --family-pages` while the marker is
 * retained, and page ids the ORIGINAL receipt already indexed are
 * recorded — never re-adopted.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprint, loadConfig, policyWeakenedCandidate, type TempRepo } from '@gate-forge/core';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import {
  FIXED_AT,
  PLUGIN_SOURCE,
  configYml,
  fixtureFingerprint,
  installFixture,
  runCli,
  withTempRepo,
} from './helpers.js';

const BASELINE_PATH = '.gateforge/baselines/obligations.json';
const RECORD_PATH = '.gateforge/baselines/adoption.json';
const WAIVERS_DIR = '.gateforge/waivers';

const ACCOUNTS_FP = fixtureFingerprint('tenant.accounts');

/** The react-router pack as a `.gateforge.yml` plugins block (in-process). */
const REACT_ROUTER_PLUGIN_BLOCK =
  `  - id: gateforge.pack-react-router\n    version: '0.13.0'\n` +
  `    transport: in-process\n    module: '@gate-forge/pack-react-router'`;

/** The fixture plugin block that stays. */
const TABLES_PLUGIN_BLOCK =
  `  - id: fixture.plugin\n    version: '1.0.0'\n` +
  `    transport: in-process\n    module: ./plugin.mjs`;

/**
 * The fixture plugin restricted to `.txt` tables: with `.tsx` routes in
 * the scan roots, the unfiltered line-per-resource plugin would emit a
 * garbage resource per JSX line — the filter keeps the tables fixture
 * and the page reader cleanly separated.
 */
const TABLES_PLUGIN_SOURCE = PLUGIN_SOURCE.replace(
  '    for (const rel of paths) {',
  "    for (const rel of paths) {\n      if (!rel.endsWith('.txt')) continue;",
);

/**
 * The pages-phase `.gateforge.yml`: both plugins over both extensions,
 * the react-router coverage entry the page reader's scan declares, and
 * the given `pages.audiences` rows.
 */
function pagesConfigYml(audienceRows: string): string {
  return `${configYml({
    include: "['src/**/*.txt', 'src/**/*.tsx']",
    plugins: `${TABLES_PLUGIN_BLOCK}\n${REACT_ROUTER_PLUGIN_BLOCK}`,
    scan: {
      scanRoots: "['src/**/*.txt', 'src/**/*.tsx']",
      coverage:
        "coverage: [{ capability: pages.react-router, detector: gateforge.pack-react-router, appliesTo: ['src/**/*.tsx'] }]",
    },
  })}pages:
  router: react-router
  audiences:
${audienceRows}
  errorMarkers: []
  params: {}
  exclude: []
  sweep: true
`;
}

const TENANT_AUDIENCE_ROW = '    - name: tenant\n      loginRoute: /login\n      guard: TenantGuard';

/** The route tree the react-router detector reads (JSX route tree). */
function routesTsx(routes: readonly string[]): string {
  return `export const routes = <>${routes.join('')} </>;\n`;
}

const ORDERS_ROUTE = '<Route path="/orders" element={<TenantGuard><Orders /></TenantGuard>} />';
const CUSTOMERS_ROUTE =
  '<Route path="/customers" element={<TenantGuard><Customers /></TenantGuard>} />';

/** The stable ui.page resource id the detector derives (audience:path hash, no source line). */
function pageId(audience: string, path: string): string {
  const slug = path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'index';
  const hash = createHash('sha256').update(`${audience}:${path}`).digest('hex').slice(0, 8);
  return `${audience}.page-${slug}-${hash}`;
}

/** Pin-#2 fingerprint of one page obligation (policyId `page-policy`, lifecycle all-off). */
function pageFp(id: string, contract: 'page:loads' | 'page:data-ok'): string {
  return fingerprint({
    resourceId: id,
    contract,
    policyId: 'page-policy',
    lifecycle: { create: false, read: false, update: false, delete: false },
  });
}

function pageFps(audience: string, paths: readonly string[]): string[] {
  return paths
    .flatMap((path) => [pageFp(pageId(audience, path), 'page:data-ok'), pageFp(pageId(audience, path), 'page:loads')])
    .sort();
}

/** The adoption receipt on disk. */
function receipt(repo: { path(relative: string): string }): Record<string, unknown> {
  return JSON.parse(readFileSync(repo.path(RECORD_PATH), 'utf8')) as Record<string, unknown>;
}

function receiptBytes(repo: { path(relative: string): string }): string {
  return readFileSync(repo.path(RECORD_PATH), 'utf8');
}

function baselineBytes(repo: { path(relative: string): string }): string {
  return readFileSync(repo.path(BASELINE_PATH), 'utf8');
}

interface Report {
  summary: {
    missing: number;
    waived: number;
    blocking: number;
    baselinedObligations?: number;
    baselinedBlockingEntries?: number;
  };
  blocking: Array<{ detail: string }>;
}

/** Phase A: the standard fixture reduced to ONE table, adopted with NO pages anywhere. */
async function installAdoptedTableRepo(repo: TempRepo): Promise<void> {
  installFixture(repo);
  // The second fixture table would only add a second fingerprint to
  // every count below; one table keeps the expectations exact.
  repo.writeFiles({ 'src/orders.txt': '', 'plugin.mjs': TABLES_PLUGIN_SOURCE });
  rmSync(repo.path('.gateforge/adapters/orders.mjs'));
  const adopted = await runCli(repo, ['adopt']);
  expect(adopted.code, `${adopted.stdout}\n${adopted.stderr}`).toBe(0);
  // The pre-pages receipt has NO families field and indexes only the table.
  const record = receipt(repo);
  expect(record['families']).toBeUndefined();
  expect(record['adopted']).toBe(1);
}

/** Phase B: introduce the pages rollout (react-router plugin + routes + pages config). */
function installPages(repo: {
  writeFiles(files: Record<string, string>): void;
  path(relative: string): string;
}, audienceRows: string = TENANT_AUDIENCE_ROW, routes: readonly string[] = [ORDERS_ROUTE, CUSTOMERS_ROUTE]): void {
  repo.writeFiles({
    '.gateforge.yml': pagesConfigYml(audienceRows),
    'plugin.mjs': TABLES_PLUGIN_SOURCE,
    'src/routes.tsx': routesTsx(routes),
  });
}

describe('gateforge adopt — the pages family marker on a PLAIN initial adopt', () => {
  it('records the family with EMPTY forgiveness; the baseline document carries the debt and shrinks it', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ 'src/orders.txt': '' });
      rmSync(repo.path('.gateforge/adapters/orders.mjs'));
      installPages(repo);
      const adopted = await runCli(repo, ['adopt']);
      expect(adopted.code, `${adopted.stdout}\n${adopted.stderr}`).toBe(0);

      const ordersId = pageId('tenant', '/orders');
      const record = receipt(repo);
      const families = record['families'] as Record<string, Record<string, unknown>>;
      const pages = families['pages']!;
      expect(pages['adoptedAt']).toBe(FIXED_AT);
      expect(Object.keys(pages['fingerprintsById'] as Record<string, string>).sort()).toEqual(
        [ordersId, pageId('tenant', '/customers')].flatMap((id) => [`${id}:page:data-ok`, `${id}:page:loads`]).sort(),
      );
      // The marker forgives NOTHING: the page debt rides the baseline
      // bulk-add, where the ordinary shrink-only contract removes it —
      // one forgiveness store, not two.
      expect(pages['forgiven']).toEqual([]);
      const pageFingerprintList = pageFps('tenant', ['/orders', '/customers']);
      const baseline = JSON.parse(baselineBytes(repo)) as { fingerprints: string[] };
      expect([...baseline.fingerprints].sort()).toEqual(
        [ACCOUNTS_FP, ...pageFingerprintList].sort(),
      );

      // The plain shrink contract still governs the page debt: shrinking
      // the document to the table alone un-forgives every page — and the
      // family fold cannot resurrect what the document no longer carries.
      const shrink = await runCli(repo, ['baseline', 'update', ACCOUNTS_FP]);
      expect(shrink.code, `${shrink.stdout}\n${shrink.stderr}`).toBe(0);
      expect((JSON.parse(receiptBytes(repo)) as Record<string, unknown>)['families']).toEqual(families);
      const afterShrink = await runCli(repo, ['check', '--format', 'json']);
      expect(afterShrink.code).toBe(1);
      expect((JSON.parse(afterShrink.stdout) as Report).summary.missing).toBe(4);

      // The marker is permanent through the shrink: a repeat records
      // nothing.
      const repeat = await runCli(repo, ['adopt', '--family', 'pages']);
      expect(repeat.code).toBe(0);
      const confirmed = await runCli(repo, ['adopt', '--family', 'pages', '--confirm']);
      expect(confirmed.code).toBe(0);
      // The no-op wrote nothing: the receipt bytes are exactly the marker
      // captured before the repeats.
      expect(receiptBytes(repo)).toBe(`${JSON.stringify(record, null, 2)}\n`);
      expect((JSON.parse(receiptBytes(repo)) as Record<string, unknown>)['families']).toEqual(families);
    });
  });
});

describe('gateforge adopt --family pages — the migration of an already-adopted repo', () => {
  it('preview writes nothing; confirm forgives ONLY the new page debt in one receipt write', async () => {
    await withTempRepo({}, async (repo) => {
      await installAdoptedTableRepo(repo);
      installPages(repo);
      const beforeCheck = await runCli(repo, ['check', '--format', 'json']);
      expect(beforeCheck.code).toBe(1);
      const beforeReport = JSON.parse(beforeCheck.stdout) as Report;
      expect(beforeReport.summary.missing).toBe(4);

      const receiptBefore = receiptBytes(repo);
      const baselineBefore = baselineBytes(repo);
      const preview = await runCli(repo, ['adopt', '--family', 'pages']);
      expect(preview.code).toBe(0);
      expect(receiptBytes(repo)).toBe(receiptBefore);
      expect(baselineBytes(repo)).toBe(baselineBefore);

      const confirmed = await runCli(repo, ['adopt', '--family', 'pages', '--confirm']);
      expect(confirmed.code, `${confirmed.stdout}\n${confirmed.stderr}`).toBe(0);

      // The receipt alone carries the new sanction; the document is
      // byte-identical (crash safety: no two-file add transaction).
      expect(baselineBytes(repo)).toBe(baselineBefore);
      const record = receipt(repo);
      expect(record['adoptedAt']).toBe(FIXED_AT); // original fields preserved
      expect(record['adopted']).toBe(1);
      const families = record['families'] as Record<string, Record<string, unknown>>;
      const pages = families['pages']!;
      expect(pages['adoptedAt']).toBe(FIXED_AT);
      expect(pages['forgiven']).toEqual(pageFps('tenant', ['/orders', '/customers']));
      expect(Object.keys(pages['fingerprintsById'] as Record<string, string>).length).toBe(4);

      const afterCheck = await runCli(repo, ['check', '--format', 'json']);
      expect(afterCheck.code, `${afterCheck.stdout}\n${afterCheck.stderr}`).toBe(0);
      const afterReport = JSON.parse(afterCheck.stdout) as Report;
      expect(afterReport.summary.waived).toBe(5); // 1 document + 4 family
      expect(afterReport.summary.missing).toBe(0);
    });
  });

  it('does not adopt an exempted page as debt, and blocks it once its waiver is removed', async () => {
    await withTempRepo({}, async (repo) => {
      await installAdoptedTableRepo(repo);
      installPages(repo);
      for (const id of [pageId('tenant', '/orders'), pageId('tenant', '/customers')].flatMap((page) => [
        `${page}:page:data-ok`,
        `${page}:page:loads`,
      ])) {
        const waived = await runCli(repo, [
          'waive',
          id,
          '--owner',
          'owner',
          '--approver',
          'approver',
          '--justification-url',
          'https://example.test/waiver',
          '--expires',
          '2027-01-01',
        ]);
        expect(waived.code, `${waived.stdout}\n${waived.stderr}`).toBe(0);
      }
      const waivedCheck = await runCli(repo, ['check', '--format', 'json']);
      expect(waivedCheck.code, `${waivedCheck.stdout}\n${waivedCheck.stderr}`).toBe(0);

      const preview = await runCli(repo, ['adopt', '--family', 'pages']);
      expect(preview.code).toBe(0);
      const confirmed = await runCli(repo, ['adopt', '--family', 'pages', '--confirm']);
      expect(confirmed.code, `${confirmed.stdout}\n${confirmed.stderr}`).toBe(0);
      const pages = (receipt(repo)['families'] as Record<string, Record<string, unknown>>)['pages']!;
      expect(pages['forgiven']).toEqual([]);
      expect(Object.keys(pages['fingerprintsById'] as Record<string, string>).length).toBe(4);

      // Remove the waivers: the proven pages BREAK, and they block —
      // they were recorded, never converted into adopted debt.
      for (const name of readdirSync(repo.path(WAIVERS_DIR))) {
        rmSync(join(repo.path(WAIVERS_DIR), name));
      }
      const broken = await runCli(repo, ['check', '--format', 'json']);
      expect(broken.code).toBe(1);
      const brokenReport = JSON.parse(broken.stdout) as Report;
      expect(brokenReport.summary.missing).toBe(4);
    });
  });

  it('a page discovered after the migration blocks, and a repeat records nothing', async () => {
    await withTempRepo({}, async (repo) => {
      await installAdoptedTableRepo(repo);
      installPages(repo);
      expect((await runCli(repo, ['adopt', '--family', 'pages', '--confirm'])).code).toBe(0);
      const settled = receiptBytes(repo);

      repo.writeFiles({
        'src/routes.tsx': routesTsx([
          ORDERS_ROUTE,
          CUSTOMERS_ROUTE,
          '<Route path="/reports" element={<TenantGuard><Reports /></TenantGuard>} />',
        ]),
      });
      const newPage = await runCli(repo, ['check', '--format', 'json']);
      expect(newPage.code).toBe(1);
      const newReport = JSON.parse(newPage.stdout) as Report;
      expect(newReport.summary.missing).toBe(2); // only the new page's two promises

      const repeat = await runCli(repo, ['adopt', '--family', 'pages', '--confirm']);
      expect(repeat.code).toBe(0);
      expect(receiptBytes(repo)).toBe(settled);
    });
  });

  it('baseline shrink removes family debt without resetting the marker; unknown and no-marker fail closed', async () => {
    await withTempRepo({}, async (repo) => {
      await installAdoptedTableRepo(repo);
      installPages(repo);
      expect((await runCli(repo, ['adopt', '--family', 'pages', '--confirm'])).code).toBe(0);
      const [ordersFpOne, ordersFpTwo] = pageFps('tenant', ['/orders']);
      const marker = (receipt(repo)['families'] as Record<string, Record<string, unknown>>)['pages']!;

      const shrink = await runCli(repo, [
        'baseline',
        'update',
        '--family-pages',
        ordersFpOne!,
        '--family-pages',
        ordersFpTwo!,
      ]);
      expect(shrink.code, `${shrink.stdout}\n${shrink.stderr}`).toBe(0);
      const shrunk = (receipt(repo)['families'] as Record<string, Record<string, unknown>>)['pages']!;
      expect(shrunk['forgiven']).toEqual([ordersFpOne, ordersFpTwo].sort());
      expect(shrunk['adoptedAt']).toBe(marker['adoptedAt']); // marker retained
      expect(shrunk['fingerprintsById']).toEqual(marker['fingerprintsById']);
      const halfShrunk = await runCli(repo, ['check', '--format', 'json']);
      expect(halfShrunk.code).toBe(1); // the customers page debt blocks again
      expect((JSON.parse(halfShrunk.stdout) as Report).summary.missing).toBe(2);

      const laundry = await runCli(repo, ['baseline', 'update', '--family-pages', 'f'.repeat(64)]);
      expect(laundry.code).toBe(2);
      expect((receipt(repo)['families'] as Record<string, Record<string, unknown>>)['pages']!['forgiven']).toEqual(
        [ordersFpOne, ordersFpTwo].sort(),
      );

      const keepNone = await runCli(repo, ['baseline', 'update', '--family-pages=']);
      expect(keepNone.code, `${keepNone.stdout}\n${keepNone.stderr}`).toBe(0);
      expect(
        (receipt(repo)['families'] as Record<string, Record<string, unknown>>)['pages']!['forgiven'],
      ).toEqual([]);
      expect(
        Object.keys(
          (receipt(repo)['families'] as Record<string, Record<string, unknown>>)['pages']![
            'fingerprintsById'
          ] as Record<string, string>,
        ).length,
      ).toBe(4); // marker fully retained
      expect((await runCli(repo, ['check'])).code).toBe(1);

      // The marker is still permanent after every shrink.
      const beforeRepeat = receiptBytes(repo);
      expect((await runCli(repo, ['adopt', '--family', 'pages', '--confirm'])).code).toBe(0);
      expect(receiptBytes(repo)).toBe(beforeRepeat);
    });
  });

  it('unresolved audience or plane refuses (exit 2, nothing written); an explicit plane resolves it', async () => {
    await withTempRepo({}, async (repo) => {
      await installAdoptedTableRepo(repo);
      const receiptBefore = receiptBytes(repo);
      const baselineBefore = baselineBytes(repo);

      // Audience `unknown`: a guard no audience declares.
      installPages(repo, TENANT_AUDIENCE_ROW, [
        ORDERS_ROUTE,
        '<Route path="/settings" element={<OtherGuard><Settings /></OtherGuard>} />',
      ]);
      const unknownPreview = await runCli(repo, ['adopt', '--family', 'pages']);
      expect(unknownPreview.code).toBe(2);
      expect(receiptBytes(repo)).toBe(receiptBefore);
      expect(baselineBytes(repo)).toBe(baselineBefore);
      expect((await runCli(repo, ['adopt', '--family', 'pages', '--confirm'])).code).toBe(2);
      expect(receiptBytes(repo)).toBe(receiptBefore);

      // Audience `employee` (a ROLE, not a plane) with no explicit plane.
      installPages(
        repo,
        `${TENANT_AUDIENCE_ROW}\n    - name: employee\n      loginRoute: /login\n      guard: EmployeeGuard`,
        [ORDERS_ROUTE, '<Route path="/staff" element={<EmployeeGuard><Staff /></EmployeeGuard>} />'],
      );
      const noPlane = await runCli(repo, ['adopt', '--family', 'pages']);
      expect(noPlane.code).toBe(2);
      expect(receiptBytes(repo)).toBe(receiptBefore);

      // The explicit plane answers it (employee → tenant data plane).
      installPages(
        repo,
        `${TENANT_AUDIENCE_ROW}\n    - name: employee\n      loginRoute: /login\n      guard: EmployeeGuard\n      plane: tenant`,
        [ORDERS_ROUTE, '<Route path="/staff" element={<EmployeeGuard><Staff /></EmployeeGuard>} />'],
      );
      const resolved = await runCli(repo, ['adopt', '--family', 'pages', '--confirm']);
      expect(resolved.code, `${resolved.stdout}\n${resolved.stderr}`).toBe(0);
      expect(
        Object.keys(
          (receipt(repo)['families'] as Record<string, Record<string, unknown>>)['pages']![
            'fingerprintsById'
          ] as Record<string, string>,
        ).length,
      ).toBe(4);
    });
  });

  it('fails on a repo with no page routes and on an unadopted repo (no marker, nothing written)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const unadopted = await runCli(repo, ['adopt', '--family', 'pages']);
      expect(unadopted.code).toBe(2);
      expect(existsSync(repo.path(RECORD_PATH))).toBe(false);

      expect((await runCli(repo, ['adopt'])).code).toBe(0);
      const receiptBefore = receiptBytes(repo);
      const noPages = await runCli(repo, ['adopt', '--family', 'pages']);
      expect(noPages.code).toBe(2);
      expect(receiptBytes(repo)).toBe(receiptBefore);
      expect(receipt(repo)['families']).toBeUndefined();

      // No marker anywhere → the family shrink fails closed too.
      const noMarkerShrink = await runCli(repo, ['baseline', 'update', '--family-pages=']);
      expect(noMarkerShrink.code).toBe(2);
      expect(receiptBytes(repo)).toBe(receiptBefore);
    });
  });

  it('a page id the ORIGINAL receipt already indexed is recorded, never re-adopted', async () => {
    await withTempRepo({}, async (repo) => {
      await installAdoptedTableRepo(repo);
      installPages(repo);
      // Simulate an earlier-0.13 plain adopt that already KNEW the pages
      // (indexed, proven — not in the baseline document) but predates the
      // family marker: the receipt indexes the page ids, the document
      // does not carry their fingerprints, and `families` is absent.
      const indexed = {
        ...(receipt(repo) as {
          obligationFingerprintsById?: Record<string, string>;
          [key: string]: unknown;
        }),
        obligationFingerprintsById: {
          'tenant.accounts:persistence:read': ACCOUNTS_FP,
          [`${pageId('tenant', '/orders')}:page:data-ok`]: pageFp(pageId('tenant', '/orders'), 'page:data-ok'),
          [`${pageId('tenant', '/orders')}:page:loads`]: pageFp(pageId('tenant', '/orders'), 'page:loads'),
          [`${pageId('tenant', '/customers')}:page:data-ok`]: pageFp(pageId('tenant', '/customers'), 'page:data-ok'),
          [`${pageId('tenant', '/customers')}:page:loads`]: pageFp(pageId('tenant', '/customers'), 'page:loads'),
        },
      };
      repo.writeFiles({ [RECORD_PATH]: `${JSON.stringify(indexed, null, 2)}\n` });

      const preview = await runCli(repo, ['adopt', '--family', 'pages']);
      expect(preview.code).toBe(0);

      const confirmed = await runCli(repo, ['adopt', '--family', 'pages', '--confirm']);
      expect(confirmed.code, `${confirmed.stdout}\n${confirmed.stderr}`).toBe(0);
      const pages = (receipt(repo)['families'] as Record<string, Record<string, unknown>>)['pages']!;
      expect(pages['forgiven']).toEqual([]); // nothing re-adopted
      expect(Object.keys(pages['fingerprintsById'] as Record<string, string>).length).toBe(4);

      // The formerly proven pages still BLOCK: they were never converted
      // into adopted debt by the migration.
      const blocked = await runCli(repo, ['check', '--format', 'json']);
      expect(blocked.code).toBe(1);
      const blockedReport = JSON.parse(blocked.stdout) as Report;
      expect(blockedReport.summary.missing).toBe(4);
    });
  });

  it('a confirmed migration changes the trusted-policy digest; the old pin no longer trusts it', async () => {
    await withTempRepo({}, async (repo) => {
      await installAdoptedTableRepo(repo);
      const before = trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml')));
      installPages(repo);
      // The pages rollout itself is a policy change (config bytes), so
      // pin the CURRENT revision first: the migration-specific change is
      // the receipt the confirm writes.
      repo.stage();
      const pinned = trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml')));
      expect(pinned).not.toBe(before);

      expect((await runCli(repo, ['adopt', '--family', 'pages', '--confirm'])).code).toBe(0);
      const after = trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml')));
      expect(after).not.toBe(pinned);
      // A gate pinned to the pre-migration revision is a weakening
      // candidate: only an EXTERNAL repin can trust the migrated receipt.
      expect(policyWeakenedCandidate(pinned, after).weakened).toBe(true);
      expect(policyWeakenedCandidate(after, after).weakened).toBe(false);
    });
  });
});
