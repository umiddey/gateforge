import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

export interface PageResource {
  schemaVersion: 1;
  id: string;
  kind: 'ui.page';
  source: string;
  location: { file: string; line: number; col: number };
  detectorVersion: string;
  attributes: { path: string; params: string[]; audience: string; source: string; resourceName: string; plane?: 'tenant' | 'master' | 'global' };
}
export interface PageDetector { discover(paths: readonly string[], context?: { root?: string; sections?: Record<string, unknown> }): { resources: PageResource[]; unresolved: Array<{ code: string; detail: string; location: { file: string; line: number; col: number } }>; findings: Array<{ code: string; detail: string; locations: Array<{ file: string; line: number; col: number }> }>; classificationSignals: []; scannedPaths: string[] } }
const EXT = /\.(tsx?|jsx?)$/;
function files(input: readonly string[], root: string): string[] {
  const out: string[] = [];
  const skipDirectories: Record<string, true> = { node_modules: true, dist: true, build: true, coverage: true, '.git': true, '.next': true, '.turbo': true, '.cache': true, __tests__: true, test: true, tests: true, e2e: true };
  const walk = (p: string): void => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) if (skipDirectories[name] !== true) walk(resolve(p, name));
    } else if (EXT.test(p) && !/\.(?:test|spec)\.[^.]+$/.test(p)) out.push(p);
  };
  for (const p of input) walk(resolve(root, p));
  return [...new Set(out)].sort();
}
function literal(node: ts.Expression | undefined): string | undefined { return node && ts.isStringLiteralLike(node) ? node.text : undefined; }
function cleanJoin(parent: string, child: string): string { if (child.startsWith('/')) return child; return `${parent.replace(/\/$/, '')}/${child}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/'; }
function params(path: string): string[] { return [...path.matchAll(/:([A-Za-z_$][\w$]*)/g)].map(m => m[1]!); }
export function createPageDetector(options: { root?: string } = {}): PageDetector {
 return { discover(paths, context) {
  const root = options.root ?? context?.root ?? process.cwd();
  const resources: PageResource[] = [], unresolved: PageDetector['discover'] extends (...args: never[]) => infer R ? R extends { unresolved: infer U } ? U : never : never = [];
  const findings: Array<{code:string;detail:string;locations:Array<{file:string;line:number;col:number}>}> = [];
  const scannedPaths: string[] = [];
  const pageConfig = context?.sections?.pages as { router?: string; exclude?: string[]; audiences?: Array<{ name: string; guard?: string; pathPrefix?: string; plane?: 'tenant' | 'master' | 'global' }> } | undefined;
  const audiences = pageConfig?.audiences ?? [];
  const add = (path: string, file: string, line: number, guard: string | undefined, redirect: boolean, catchall: boolean): void => {
   if (catchall || redirect || pageConfig?.exclude?.includes(path)) return;
   const audienceConfig = audiences.find(a => (a.guard && a.guard === guard) || (a.pathPrefix && (path === a.pathPrefix || path.startsWith(`${a.pathPrefix.replace(/\/$/, '')}/`))));
   const audience = audienceConfig?.name ?? 'unknown';
   const slug = path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'index';
   const hash = createHash('sha256').update(`${audience}:${path}`).digest('hex').slice(0, 8);
   const location = { file, line, col: 0 };
   const resourceName = `page-${slug}-${hash}`;
   const plane = audienceConfig?.plane ?? (['tenant', 'master', 'global'].includes(audience) ? audience as 'tenant' | 'master' | 'global' : undefined);
   const attributes = { path, params: params(path), audience, source: `${file}:${line}`, resourceName, ...(plane === undefined ? {} : { plane }) };
   resources.push({ schemaVersion: 1, id: `${audience}.${resourceName}`, kind: 'ui.page', source: file, location, detectorVersion: '0.13.0', attributes });
  };
  if (pageConfig?.router === 'manual') {
   const manualPath = resolve(root, '.gateforge/pages.yml');
   if (!existsSync(manualPath)) {
    unresolved.push({ code: 'PAGE_CONFIG_INVALID', detail: "pages.router is 'manual' but .gateforge/pages.yml is missing", location: { file: '.gateforge/pages.yml', line: 1, col: 0 } });
   } else {
    try {
     const document = parseYaml(readFileSync(manualPath, 'utf8')) as { pages?: Array<{ path: string; audience: string; source: string }> };
     if (!Array.isArray(document.pages)) throw new Error("expected 'pages' array");
     for (const page of document.pages) {
      if (typeof page.path !== 'string' || !page.path.startsWith('/') || typeof page.audience !== 'string' || typeof page.source !== 'string') throw new Error('each page requires absolute path, audience and source');
      const split = page.source.lastIndexOf(':');
      if (split < 1) throw new Error(`source must be file:line, got '${page.source}'`);
      const sourceFile = page.source.slice(0, split);
      const sourceLine = Number(page.source.slice(split + 1));
      if (sourceFile.startsWith('/') || sourceFile.split('/').includes('..') || !Number.isInteger(sourceLine) || sourceLine < 1) throw new Error(`invalid source location '${page.source}'`);
      if (pageConfig.exclude?.includes(page.path)) continue;
      const slug = page.path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'index';
      const hash = createHash('sha256').update(`${page.audience}:${page.path}`).digest('hex').slice(0, 8);
      const resourceName = `page-${slug}-${hash}`;
      const plane = audiences.find(a => a.name === page.audience)?.plane ?? (['tenant', 'master', 'global'].includes(page.audience) ? page.audience as 'tenant' | 'master' | 'global' : undefined);
      const attributes = { path: page.path, params: params(page.path), audience: page.audience, source: page.source, resourceName, ...(plane === undefined ? {} : { plane }) };
      resources.push({ schemaVersion: 1, id: `${page.audience}.${resourceName}`, kind: 'ui.page', source: sourceFile, location: { file: sourceFile, line: sourceLine, col: 0 }, detectorVersion: '0.13.0', attributes });
     }
    } catch (error) {
     unresolved.push({ code: 'PAGE_CONFIG_INVALID', detail: `invalid .gateforge/pages.yml: ${error instanceof Error ? error.message : String(error)}`, location: { file: '.gateforge/pages.yml', line: 1, col: 0 } });
    }
   }
   return { resources, unresolved, findings, classificationSignals: [], scannedPaths };
  }
  for (const full of files(paths, root)) {
   let text: string; try { text = readFileSync(full, 'utf8'); } catch { continue; }
   const file = relative(root, full).split(sep).join('/'); scannedPaths.push(file);
   const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
   const visit = (node: ts.Node, parentPath = '', inheritedGuard?: string): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
     const tagName = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
     const attributes = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
     const tag = tagName.getText(source).split('.').pop();
     if (tag === 'Route') {
      const attrs = attributes.properties.filter(ts.isJsxAttribute);
      const pathAttr = attrs.find(a => a.name.getText(source) === 'path');
      const pathInitializer = pathAttr?.initializer;
      const pathExpression = pathInitializer && ts.isJsxExpression(pathInitializer) ? pathInitializer.expression : pathInitializer;
      const path = pathExpression && ts.isStringLiteralLike(pathExpression) ? pathExpression.text : undefined;
      const index = attrs.some(a => a.name.getText(source) === 'index');
      const element = attrs.find(a => a.name.getText(source) === 'element')?.initializer;
      const redirect = !!element && element.getText(source).includes('Navigate');
      const guard = element?.getText(source).match(/<\s*([\w$.]*(?:Guard|ProtectedRoute))\b/)?.[1]?.split('.').pop() ?? inheritedGuard;
      const loc = source.getLineAndCharacterOfPosition(node.getStart(source));
      if (pathAttr && !path && !index) unresolved.push({ code: 'PAGE_ROUTE_UNRESOLVED', detail: `computed or unreadable route path in ${file}:${loc.line + 1}`, location: { file, line: loc.line + 1, col: loc.character } });
      if (path || index) add(index ? (parentPath || '/') : cleanJoin(parentPath, path!), file, loc.line + 1, guard, redirect, path === '*' || (path !== undefined && path.endsWith('/*')));
      const childParent = index ? parentPath : path ? cleanJoin(parentPath, path) : parentPath;
      if (ts.isJsxElement(node)) for (const child of node.children) visit(child, childParent, guard);
      return;
     }
    }
    if (ts.isCallExpression(node) && ['createBrowserRouter', 'useRoutes'].includes(node.expression.getText(source))) {
     const arg = node.arguments[0]; if (arg) visitObjectRoutes(arg, parentPath);
    }
    ts.forEachChild(node, child => visit(child, parentPath, inheritedGuard));
   };
   const visitObjectRoutes = (expr: ts.Expression, base: string): void => {
    if (!ts.isArrayLiteralExpression(expr)) {
     const loc = source.getLineAndCharacterOfPosition(expr.getStart(source));
     unresolved.push({ code: 'PAGE_ROUTE_UNRESOLVED', detail: `unreadable route array in ${file}:${loc.line + 1}`, location: { file, line: loc.line + 1, col: loc.character } });
     return;
    }
    for (const el of expr.elements) {
     if (!ts.isObjectLiteralExpression(el)) {
      const loc = source.getLineAndCharacterOfPosition(el.getStart(source));
      unresolved.push({ code: 'PAGE_ROUTE_UNRESOLVED', detail: `spread or unreadable route in ${file}:${loc.line + 1}`, location: { file, line: loc.line + 1, col: loc.character } });
      continue;
     }
     const prop = (n: string) => el.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source).replace(/['"]/g, '') === n) as ts.PropertyAssignment | undefined;
     const pathProperty = prop('path');
     const path = literal(pathProperty?.initializer);
     const index = prop('index')?.initializer?.kind === ts.SyntaxKind.TrueKeyword;
     const element = prop('element')?.initializer ?? prop('Component')?.initializer ?? prop('lazy')?.initializer;
     const redirect = !!element && element.getText(source).includes('Navigate');
     const loc = source.getLineAndCharacterOfPosition(el.getStart(source));
     if (pathProperty && !path && !index) unresolved.push({ code: 'PAGE_ROUTE_UNRESOLVED', detail: `computed or unreadable route path in ${file}:${loc.line + 1}`, location: { file, line: loc.line + 1, col: loc.character } });
     else if (path || index) add(index ? (base || '/') : cleanJoin(base, path!), file, loc.line + 1, undefined, redirect, path === '*' || (path !== undefined && path.endsWith('/*')));
     const children = prop('children')?.initializer;
     if (children) visitObjectRoutes(children, index ? base : path ? cleanJoin(base, path) : base);
    }
   };
   visit(source);
  }
  return { resources, unresolved, findings, classificationSignals: [], scannedPaths };
 }};
}
