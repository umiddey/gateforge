import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WitnessClient } from '../src/fixture/witness-client.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('persistence adapter timing', () => {
  it('records slow witness wall time in run diagnostics', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'gf-adapter-timing-'));
    roots.push(stateDir);
    const server = createServer((_request, response) => {
      // A real server delay is required to exercise the adapter's wall-clock threshold.
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ recordId: 'record-1', runId: 'run-1', verdictRelevant: { found: true, fieldsMatch: true } }));
      }, 2_100);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('timing server did not bind TCP');
    const previousStateDir = process.env['GATEFORGE_STATE_DIR'];
    process.env['GATEFORGE_STATE_DIR'] = stateDir;
    try {
      const client = new WitnessClient(`http://127.0.0.1:${address.port}`, 'run-token', 5_000);
      await client.verifyPersistence({
        resourceId: 'fixture.resource',
        entityId: 'entity-1',
        testId: 'fixture.spec > slow witness',
        claimId: 'fixture.claim',
        sessionId: 'session-1',
        sessionToken: 'session-token',
      });
      const timingPath = join(stateDir, 'diagnostics', 'adapter-timing.jsonl');
      const timing = JSON.parse(readFileSync(timingPath, 'utf8').trim()) as { durationMs: number; operation: string };
      expect(timing.operation).toBe('verifyPersistence');
      expect(timing.durationMs).toBeGreaterThanOrEqual(2_000);
    } finally {
      if (previousStateDir === undefined) delete process.env['GATEFORGE_STATE_DIR'];
      else process.env['GATEFORGE_STATE_DIR'] = previousStateDir;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
