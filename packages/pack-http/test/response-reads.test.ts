/**
 * Response field reads (plan 2026-09-25 Phase 4b item 5).
 *
 * The dropped-response-field bug class is invisible at runtime: a merged
 * frontend reads `invoice.dueDate`, every test mocks the response or
 * tolerates `undefined`, and the screen shows nothing. The static proof
 * is the pair of facts — what a call site reads, and what the response
 * model declares — so the read pass has to be exactly as bounded and as
 * quiet as the call pass it rides on: same file, the call's own result,
 * and nothing inferred.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpDetector, type HttpDetector } from '../src/index.js';
import { scanClientCalls } from '../src/client-calls.js';

/** A throwaway repo root the detector can read from disk. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-reads-'));
  for (const [rel, text] of Object.entries(files)) {
    const absolute = join(dir, rel);
    mkdirSync(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true });
    writeFileSync(absolute, text);
  }
  return dir;
}

const CONFIG = { clientSymbols: ['apiClient'] };

function readsOf(file: string, source: string): Array<{ field: string; line: number }> {
  const files = new Map<string, string>([[file, source]]);
  const result = scanClientCalls(file, source, CONFIG, files);
  return (result.calls[0]?.responseReads ?? []).map((read) => ({
    field: read.field,
    line: read.location.line,
  }));
}

describe('bounded response field reads', () => {
  it('reads the awaited result through .data, including inside a nested callback', () => {
    const source = [
      `export async function load() {`,          // 1
      `  const res = await apiClient.get('/invoices/1');`, // 2
      `  useEffect(() => {`,                    // 3
      `    setDue(res.data.dueDate);`,           // 4
      `    setTotal(res.data.total_cents);`,     // 5
      `  }, []);`,                               // 6
      `  return res.data.status;`,               // 7
      `}`,                                       // 8
    ].join('\n');
    expect(readsOf('src/invoices.ts', source)).toEqual([
      { field: 'dueDate', line: 4 },
      { field: 'total_cents', line: 5 },
    ]);
  });

  it('reads a destructured payload, a `.data` alias and a string index', () => {
    const destructured = [
      `const { data: invoice } = await apiClient.get('/invoices/1');`,
      `setDue(invoice.dueDate);`,
    ].join('\n');
    expect(readsOf('src/a.ts', destructured)).toEqual([{ field: 'dueDate', line: 2 }]);

    const aliased = [
      `const body = (await apiClient.get('/invoices/1')).data;`,
      `setDue(body.dueDate);`,
    ].join('\n');
    expect(readsOf('src/b.ts', aliased)).toEqual([{ field: 'dueDate', line: 2 }]);

    const inline = [`setPaid((await apiClient.get('/invoices/1')).data.paidAt);`].join('\n');
    expect(readsOf('src/c.ts', inline)).toEqual([{ field: 'paidAt', line: 1 }]);

    const indexed = [
      `const res = await apiClient.get('/invoices/1');`,
      `setDue(res.data['dueDate']);`,
    ].join('\n');
    expect(readsOf('src/d.ts', indexed)).toEqual([{ field: 'dueDate', line: 2 }]);
  });

  it('reads the keys a destructuring pattern pulls off the payload', () => {
    const source = [
      `const res = await apiClient.get('/invoices/1');`,
      `const { dueDate, total: totalCents } = res.data;`,
    ].join('\n');
    expect(readsOf('src/e.ts', source)).toEqual([
      { field: 'dueDate', line: 2 },
      { field: 'total', line: 2 },
    ]);
  });

  it('never reads a JavaScript member, a computed key or an envelope field', () => {
    const members = [
      `const res = await apiClient.get('/invoices');`,
      `return res.data.map((row) => row.id).length;`,
    ].join('\n');
    expect(readsOf('src/f.ts', members)).toEqual([]);

    const envelope = [
      `const res = await apiClient.get('/invoices/1');`,
      `if (res.status !== 200) throw new Error(res.statusText);`,
      `const auth = res.headers.authorization;`,
    ].join('\n');
    expect(readsOf('src/g.ts', envelope)).toEqual([]);
  });

  it('ignores a reassigned holder and a read outside the enclosing function', () => {
    const reassigned = [
      `let res = await apiClient.get('/invoices/1');`,
      `res = await apiClient.get('/invoices/2');`,
      `setDue(res.data.dueDate);`,
    ].join('\n');
    expect(readsOf('src/h.ts', reassigned)).toEqual([]);

    const otherFunction = [
      `export async function load() {`,
      `  const res = await apiClient.get('/invoices/1');`,
      `  return res.data.dueDate;`,
      `}`,
      `export function unrelated(res) {`,
      `  return res.data.dueDate;`,
      `}`,
    ].join('\n');
    expect(readsOf('src/i.ts', otherFunction)).toEqual([{ field: 'dueDate', line: 3 }]);
  });

  it('reports no reads — and no attribute — for a call nobody consumes', () => {
    const source = [`await apiClient.post('/invoices', payload);`].join('\n');
    const files = new Map<string, string>([['src/j.ts', source]]);
    const result = scanClientCalls('src/j.ts', source, CONFIG, files);
    expect(result.calls[0]?.responseReads).toBeUndefined();
  });

  it('attributes each read to its own call', () => {
    const source = [
      `const res = await apiClient.get('/invoices/1');`,
      `setDue(res.data.dueDate);`,
      `const other = await apiClient.get('/invoices/2');`,
      `setPaid(other.data.paidAt);`,
    ].join('\n');
    const files = new Map<string, string>([['src/k.ts', source]]);
    const result = scanClientCalls('src/k.ts', source, CONFIG, files);
    expect(
      result.calls.map((call) => ({
        path: call.rawPath,
        reads: (call.responseReads ?? []).map((read) => read.field),
      })),
    ).toEqual([
      { path: '/invoices/1', reads: ['dueDate'] },
      { path: '/invoices/2', reads: ['paidAt'] },
    ]);
  });

  it('carries the reads into the emitted contract fact', () => {
    const source = [
      `const res = await fetch('/invoices/1');`,   // fetch has no `.data` envelope
      `const other = await axios.get('/invoices/2');`,
      `setDue(other.data.dueDate);`,
    ].join('\n');
    const dir = project({ 'src/l.ts': source });
    let outcome: ReturnType<HttpDetector['discover']>;
    try {
      outcome = createHttpDetector({ root: dir }).discover(['src/l.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const calls = outcome.resources
      .filter(
        (resource) =>
          resource.kind === 'http.contract' && resource.attributes['role'] === 'frontend-call',
      )
      .map((resource) => ({
        path: resource.attributes['rawPath'],
        reads: resource.attributes['responseReads'],
      }));
    expect(calls).toEqual([
      { path: '/invoices/1', reads: undefined },
      {
        path: '/invoices/2',
        reads: [
          { field: 'dueDate', location: { file: 'src/l.ts', line: 3, col: 7 } },
        ],
      },
    ]);
  });
});
