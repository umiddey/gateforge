/**
 * `gateforge-witness` bin tests: the binary surface a test harness uses
 * for a test-gates run. Flags parse in the CLI's `--flag value` /
 * `--flag=value` style with env fallbacks; secrets (run id/token,
 * verifier key) stay environment-only; unknown flags fail closed with
 * the usage line. The started witness is a REAL loopback service: the
 * observation-proxy flag actually starts the proxy (the phase-7 gap —
 * `proxyTarget` was library-only before), with the mount path applied.
 */
import { describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { main, WITNESS_BIN_USAGE } from '../src/witness/bin.js';
import type { WitnessHandle } from '../src/witness/types.js';

const RUN_ID = '0d9d3a70-1c46-4f2e-9f7e-2b0d33e2f001';
const TOKEN = 'witness-bin-run-token';

/** Minimal loopback target: echoes the request URL it was called with. */
async function startEchoTarget(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ seen: req.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no target port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function proxyGet(proxyUrl: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const forward = httpRequest(`${proxyUrl}${path}`, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    forward.on('error', reject);
    forward.end();
  });
}

const BASE_ENV: NodeJS.ProcessEnv = {
  GATEFORGE_RUN_ID: RUN_ID,
  GATEFORGE_RUN_TOKEN: TOKEN,
};

describe('gateforge-witness bin surface', () => {
  it('--help prints the usage line and never starts a service', async () => {
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let handle: WitnessHandle;
    try {
      handle = await main(['--help'], BASE_ENV);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(writes.join('')).toContain('usage: gateforge-witness');
    expect(handle.url).toBe('');
    expect(handle.proxyUrl).toBe(null);
    await handle.stop();
  });

  it('fails closed without the CLI-contract env (run id/token)', async () => {
    await expect(main([], {})).rejects.toThrow(/GATEFORGE_RUN_ID is required/);
    await expect(main([], { GATEFORGE_RUN_ID: RUN_ID })).rejects.toThrow(
      /GATEFORGE_RUN_TOKEN is required/,
    );
  });

  it('rejects unknown flags and missing values with the usage line', async () => {
    await expect(main(['--nope'], BASE_ENV)).rejects.toThrow(/unknown flag '--nope'/);
    await expect(main(['--proxy-target'], BASE_ENV)).rejects.toThrow(
      /flag '--proxy-target' requires a value/,
    );
    await expect(main(['--proxy-target', 'http://127.0.0.1:1', 'stray'], BASE_ENV)).rejects.toThrow(
      /unexpected argument 'stray'/,
    );
    await expect(main(['--nope'], BASE_ENV)).rejects.toThrow(WITNESS_BIN_USAGE);
  });

  it('starts the observation proxy from --proxy-target and applies --mount-path', async () => {
    const target = await startEchoTarget();
    let witness: WitnessHandle | null = null;
    try {
      witness = await main(['--proxy-target', target.url, '--mount-path', '/api'], BASE_ENV);
      expect(witness.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const health = await fetch(`${witness.url}/health`, {
        headers: { 'x-gateforge-run': TOKEN },
      });
      expect(health.status).toBe(200);

      const forwarded = await proxyGet(witness.proxyUrl as string, '/api/ops/x');
      expect(forwarded.status).toBe(200);
      // The mount prefix was stripped before forwarding.
      expect(JSON.parse(forwarded.body)).toMatchObject({ seen: '/ops/x' });
    } finally {
      if (witness !== null) await witness.stop();
      await target.stop();
    }
  });

  it('env fallbacks wire the proxy; a flag overrides the env', async () => {
    const target = await startEchoTarget();
    const other = await startEchoTarget();
    let witness: WitnessHandle | null = null;
    try {
      witness = await main([], { ...BASE_ENV, GATEFORGE_PROXY_TARGET: target.url });
      expect(witness.proxyUrl).not.toBe(null);
      const health = await fetch(`${witness.url}/health`, {
        headers: { 'x-gateforge-run': TOKEN },
      });
      expect(health.status).toBe(200);
      await witness.stop();

      // The flag wins over the env value (the `other` target is ignored).
      witness = await main(['--proxy-target', target.url], {
        ...BASE_ENV,
        GATEFORGE_PROXY_TARGET: other.url,
      });
      const forwarded = await proxyGet(witness.proxyUrl as string, '/ping');
      expect(JSON.parse(forwarded.body)).toMatchObject({ seen: '/ping' });
      await witness.stop();
      witness = null;
    } finally {
      if (witness !== null) await witness.stop();
      await target.stop();
      await other.stop();
    }
  });

  it('rejects a repeated flag', async () => {
    await expect(
      main(['--mount-path', '/api', '--mount-path=/ops'], BASE_ENV),
    ).rejects.toThrow(/flag '--mount-path' may only be given once/);
  });
});
