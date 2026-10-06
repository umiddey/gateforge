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
 it('preserves page identity when route source locations change, but not when the route changes', () => {
  const source = `<Route path="/orders" element={<TenantGuard><Orders /></TenantGuard>} />`;
  const root = fixture(source);
  const detector = createPageDetector({ root });
  const context = { sections: { pages: { audiences: [{ name: 'tenant', guard: 'TenantGuard' }] } } };
  const before = detector.discover(['src'], context).resources[0]!;
  writeFileSync(join(root, 'src/routes.tsx'), `\n\n${source}`);
  const after = detector.discover(['src'], context).resources[0]!;
  expect(after.id).toBe(before.id);
  expect(after.location.line).toBe(3);
  writeFileSync(join(root, 'src/routes.tsx'), source.replace('/orders', '/customers'));
  expect(detector.discover(['src'], context).resources[0]!.id).not.toBe(before.id);
  mkdirSync(join(root, '.gateforge'));
  writeFileSync(join(root, '.gateforge/pages.yml'), `pages:\n  - path: /orders\n    audience: tenant\n    source: src/routes.tsx:3\n`);
  const manual = detector.discover(['src'], { sections: { pages: { router: 'manual' } } }).resources[0]!;
  expect(manual.id).toBe(before.id);
  writeFileSync(join(root, '.gateforge/pages.yml'), `pages:\n  - path: /orders\n    audience: master\n    source: src/routes.tsx:3\n`);
  expect(detector.discover(['src'], { sections: { pages: { router: 'manual' } } }).resources[0]!.id).not.toBe(before.id);
 });
 it('keeps login audiences distinct while resolving their explicitly declared data planes', () => {
  const root = fixture(`<><Route path="/orders" element={<TenantGuard />} /><Route path="/employee/orders" element={<EmployeeGuard />} /><Route path="/admin/orders" element={<AdminGuard />} /><Route path="/login" element={<Login />} /></>`);
  const audiences = [
   { name: 'tenant', guard: 'TenantGuard', plane: 'tenant' },
   { name: 'employee', guard: 'EmployeeGuard', plane: 'tenant' },
   { name: 'admin', guard: 'AdminGuard', plane: 'master' },
   { name: 'public', pathPrefix: '/login', plane: 'global' },
  ];
  const result = createPageDetector({ root }).discover(['src'], { sections: { pages: { audiences } } });
  expect(result.resources.map(resource => [resource.attributes.audience, resource.attributes.plane])).toEqual([
   ['tenant', 'tenant'], ['employee', 'tenant'], ['admin', 'master'], ['public', 'global'],
  ]);
  mkdirSync(join(root, '.gateforge'));
  writeFileSync(join(root, '.gateforge/pages.yml'), `pages:\n  - path: /employee/orders\n    audience: employee\n    source: src/routes.tsx:1\n`);
  const manual = createPageDetector({ root }).discover(['src'], { sections: { pages: { router: 'manual', audiences } } });
  expect(manual.resources[0]?.attributes).toMatchObject({ audience: 'employee', plane: 'tenant' });
 });
});
