import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPageDetector } from '../src/detector.js';
const roots: string[] = [];
function fixture(source: string): string { const root = mkdtempSync(join(tmpdir(), 'router-pack-')); roots.push(root); mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/routes.tsx'), source); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('React Router reader', () => {
 it('reads nested JSX, parameter pages and classifies redirects and catch-alls', () => {
  const root = fixture(`const routes = <Route path="/orders" element={<TenantGuard />}><Route path=":id" element={<Order />} /><Route path="*" element={<Fallback />} /><Route path="old" element={<Navigate to="/orders" />} /></Route>`);
  const result = createPageDetector({ root }).discover(['src']);
  expect(result.resources.map(r => r.attributes.path)).toEqual(['/orders', '/orders/:id']);
  expect(result.resources[1]?.attributes.params).toEqual(['id']);
  expect(result.unresolved).toEqual([]);
 });
 it('reads object routes and reports computed paths with source locations', () => {
  const root = fixture(`const router = createBrowserRouter([{ path: '/customers', lazy: () => import('./customers') }, { path: routePath, Component: Customers }]);`);
  const result = createPageDetector({ root }).discover(['src']);
  expect(result.resources[0]?.attributes.path).toBe('/customers');
  expect(result.unresolved[0]?.code).toBe('PAGE_ROUTE_UNRESOLVED');
  expect(result.unresolved[0]?.location).toMatchObject({ file: 'src/routes.tsx', line: 1 });
 });
 it('uses owner audience guards and reads manual pages', () => {
  const root = fixture(`const routes = <><Route path="/orders" element={<TenantGuard><Outlet /></TenantGuard>} /><Route path="/customers" element={<AdminGuard><Outlet /></AdminGuard>} /></>;`);
  const guarded = createPageDetector({ root }).discover(['src'], { root, sections: { pages: { audiences: [{ name: 'tenant', loginRoute: '/login', guard: 'TenantGuard' }, { name: 'master', loginRoute: '/admin/login', guard: 'AdminGuard' }] } } });
  expect(guarded.resources.map(resource => resource.attributes.audience)).toEqual(['tenant', 'master']);
  mkdirSync(join(root, '.gateforge'));
  writeFileSync(join(root, '.gateforge/pages.yml'), `pages:\n  - path: /customers\n    audience: tenant\n    source: src/routes.tsx:1\n`);
  const manual = createPageDetector({ root }).discover(['src'], { root, sections: { pages: { router: 'manual' } } });
  expect(manual.resources).toHaveLength(1);
  expect(manual.resources[0]?.attributes).toMatchObject({ path: '/customers', audience: 'tenant', params: [] });
 });
});
