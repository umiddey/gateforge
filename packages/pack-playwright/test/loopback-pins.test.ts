/**
 * Loopback egress binding tests (GF-10 stale-approval fix): approving a
 * hostname pins its startup-resolved loopback IPs, and every later
 * connection binds to the pins — a mid-run DNS change cannot move
 * traffic. Covers pin/caching semantics, the Chromium resolver-rules
 * builder, Host-preserving pinned reads against real loopback servers,
 * the stale-approval probe, redirect refusal, and manager launch args.
 */
import { createServer, type Server } from 'node:http';
import { chromium } from 'playwright';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  clearPinnedLoopbackForTests,
  hostResolverRules,
  isLoopbackAddress,
  pinLoopbackIps,
  pinnedGet,
  pinnedLoopbackIps,
  type PinDnsLookup,
} from '../src/witness/loopback-pins.js';
import { EngineBrowserManager } from '../src/witness/browser.js';

beforeEach(() => {
  clearPinnedLoopbackForTests();
});

describe('pin semantics', () => {
  const loopback: PinDnsLookup = async () => [{ address: '127.0.0.2', family: 4 }];

  it('pins all-loopback answers and rejects everything else', async () => {
    await expect(pinLoopbackIps('tenant.test', loopback)).resolves.toEqual(['127.0.0.2']);
    await expect(pinLoopbackIps('pub.test', async () => [{ address: '93.184.216.34', family: 4 }])).rejects.toThrow(
      'does not resolve exclusively to loopback',
    );
    await expect(
      pinLoopbackIps('mixed.test', async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ]),
    ).rejects.toThrow('does not resolve exclusively to loopback');
    await expect(pinLoopbackIps('empty.test', async () => [])).rejects.toThrow(
      'does not resolve exclusively to loopback',
    );
    await expect(
      pinLoopbackIps('dead.test', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toThrow('does not resolve to loopback');
  });

  it('first resolution wins: later DNS changes never replace the pins (stale-approval killer)', async () => {
    let calls = 0;
    const flipping: PinDnsLookup = async () => {
      calls += 1;
      return calls === 1 ? [{ address: '127.0.0.3', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
    };
    await expect(pinLoopbackIps('tenant.test', flipping)).resolves.toEqual(['127.0.0.3']);
    // The hostile answer arrives too late: the stored pins stand and no
    // second lookup even runs for the same hostname.
    await expect(pinLoopbackIps('tenant.test', flipping)).resolves.toEqual(['127.0.0.3']);
    expect(calls).toBe(1);
    expect(pinnedLoopbackIps().get('tenant.test')).toEqual(['127.0.0.3']);
  });

  it('orders IPv4 first and dedupes', async () => {
    const both: PinDnsLookup = async () => [
      { address: '::1', family: 6 },
      { address: '127.0.0.4', family: 4 },
      { address: '127.0.0.4', family: 4 },
    ];
    await expect(pinLoopbackIps('both.test', both)).resolves.toEqual(['127.0.0.4', '::1']);
  });

  it('classifies addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.2')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('93.184.216.34')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
  });
});

describe('resolver rules builder', () => {
  it('emits deterministic MAP rules, null when empty', () => {
    expect(hostResolverRules(new Map())).toBeNull();
    expect(
      hostResolverRules(
        new Map([
          ['b.test', ['127.0.0.2']],
          ['a.test', ['127.0.0.1', '::1']],
        ]),
      ),
    ).toBe('MAP a.test 127.0.0.1, MAP a.test ::1, MAP b.test 127.0.0.2');
  });
});

describe('pinned reads against real loopback servers', () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
    servers = [];
  });

  /** Serves 200 with the observed Host header echoed; binds one loopback IP. */
  async function serveEcho(ip: string, port: number, seen: { host: string | null }): Promise<void> {
    const server = createServer((req, res) => {
      seen.host = req.headers.host ?? null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((done) => server.listen(port, ip, () => done()));
    servers.push(server);
  }

  it('connects to the pinned IP with the original Host preserved (tenant routing intact)', async () => {
    const seen = { host: null as string | null };
    await serveEcho('127.0.0.2', 18801, seen);
    // tenant.test resolves nowhere in test DNS — plain fetch would
    // ENOTFOUND; the pin carries the connection.
    await pinLoopbackIps('tenant.test', async () => [{ address: '127.0.0.2', family: 4 }]);
    const response = await pinnedGet('http://tenant.test:18801/thing?q=1', { timeoutMs: 5000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen.host).toBe('tenant.test:18801');
  });

  it('stays on the pinned IP after DNS flips public (reviewer stale-approval probe)', async () => {
    const seen = { host: null as string | null };
    await serveEcho('127.0.0.3', 18802, seen);
    let calls = 0;
    const flipping: PinDnsLookup = async () => {
      calls += 1;
      return calls === 1 ? [{ address: '127.0.0.3', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
    };
    await pinLoopbackIps('tenant.test', flipping);
    // The hostile answer is already live for any fresh resolver — the
    // read must still land on the startup-approved 127.0.0.3.
    const response = await pinnedGet('http://tenant.test:18802/x', { timeoutMs: 5000 });
    expect(response.status).toBe(200);
    expect(seen.host).toBe('tenant.test:18802');
  });

  it('refuses cross-host redirects', async () => {
    const redirecting = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://other.test:18801/' });
      res.end();
    });
    await new Promise<void>((done) => redirecting.listen(18803, '127.0.0.4', () => done()));
    servers.push(redirecting);
    await pinLoopbackIps('tenant.test', async () => [{ address: '127.0.0.4', family: 4 }]);
    await expect(pinnedGet('http://tenant.test:18803/', { timeoutMs: 5000 })).rejects.toThrow(
      'refuses cross-host redirect',
    );
  });

  it('follows relative redirects on the same origin with the Host preserved', async () => {
    const seen: { host: string | null; paths: string[] } = { host: null, paths: [] };
    const server = createServer((req, res) => {
      seen.paths.push(req.url ?? '');
      seen.host = req.headers.host ?? null;
      if (req.url === '/start') {
        res.writeHead(302, { location: '/landed' });
        res.end();
      } else res.end('landed');
    });
    await new Promise<void>((done) => server.listen(18805, '127.0.0.2', () => done()));
    servers.push(server);
    await pinLoopbackIps('tenant.test', async () => [{ address: '127.0.0.2', family: 4 }]);
    const response = await pinnedGet('http://tenant.test:18805/start', { timeoutMs: 5000 });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('landed');
    expect(seen.paths).toEqual(['/start', '/landed']);
    expect(seen.host).toBe('tenant.test:18805');
  });

  it("follows a changed-port redirect on the Location's actual port (reviewer probe shape)", async () => {
    let destinationHits = 0;
    let destinationHost: string | null = null;
    let sourceResultHits = 0;
    const destination = createServer((req, res) => {
      destinationHits += 1;
      destinationHost = req.headers.host ?? null;
      res.end('destination');
    });
    await new Promise<void>((done) => destination.listen(18806, '127.0.0.3', () => done()));
    servers.push(destination);
    const source = createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: 'http://tenant.test:18806/result' });
        res.end();
      } else {
        sourceResultHits += 1;
        res.end('source');
      }
    });
    await new Promise<void>((done) => source.listen(18807, '127.0.0.3', () => done()));
    servers.push(source);
    await pinLoopbackIps('tenant.test', async () => [{ address: '127.0.0.3', family: 4 }]);
    const response = await pinnedGet('http://tenant.test:18807/start', { timeoutMs: 5000 });
    // The redirect's ACTUAL destination answers — not the old origin
    // re-requested with the new path (the reviewer's defect: body was
    // 'source' with destinationHits 0).
    expect(await response.text()).toBe('destination');
    expect(destinationHits).toBe(1);
    expect(sourceResultHits).toBe(0);
    // Tenant routing follows the hop: the Host header names the pinned
    // hostname at the redirect's port.
    expect(destinationHost).toBe('tenant.test:18806');
  });

  it('resolves a later relative redirect against the NEW origin after a port change', async () => {
    const seen: string[] = [];
    const destination = createServer((req, res) => {
      seen.push(req.url ?? '');
      if (req.url === '/hop') {
        res.writeHead(302, { location: 'final' }); // relative → same host+port as /hop
        res.end();
      } else res.end('chained');
    });
    await new Promise<void>((done) => destination.listen(18808, '127.0.0.3', () => done()));
    servers.push(destination);
    const source = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://tenant.test:18808/hop' });
      res.end();
    });
    await new Promise<void>((done) => source.listen(18809, '127.0.0.3', () => done()));
    servers.push(source);
    await pinLoopbackIps('tenant.test', async () => [{ address: '127.0.0.3', family: 4 }]);
    const response = await pinnedGet('http://tenant.test:18809/start', { timeoutMs: 5000 });
    expect(await response.text()).toBe('chained');
    expect(seen).toEqual(['/hop', '/final']);
  });

  it('refuses cross-scheme redirects instead of silently switching transports', async () => {
    let destinationHits = 0;
    const destination = createServer((_req, res) => {
      destinationHits += 1;
      res.end('should-not-be-reached');
    });
    await new Promise<void>((done) => destination.listen(18810, '127.0.0.4', () => done()));
    servers.push(destination);
    const source = createServer((_req, res) => {
      res.writeHead(302, { location: 'https://tenant.test:18810/secure' });
      res.end();
    });
    await new Promise<void>((done) => source.listen(18811, '127.0.0.4', () => done()));
    servers.push(source);
    await pinLoopbackIps('tenant.test', async () => [{ address: '127.0.0.4', family: 4 }]);
    await expect(pinnedGet('http://tenant.test:18811/start', { timeoutMs: 5000 })).rejects.toThrow(
      'refuses cross-scheme redirect',
    );
    // Nothing was requested at the named destination either — not over
    // http (silent misfollow) and not a TLS attempt against the pinned
    // IP that could never verify a certificate.
    expect(destinationHits).toBe(0);
  });

  it('exhausts the redirect budget instead of looping forever', async () => {
    let hits = 0;
    const looper = createServer((_req, res) => {
      hits += 1;
      res.writeHead(302, { location: '/loop' });
      res.end();
    });
    await new Promise<void>((done) => looper.listen(18812, '127.0.0.2', () => done()));
    servers.push(looper);
    await pinLoopbackIps('tenant.test', async () => [{ address: '127.0.0.2', family: 4 }]);
    await expect(
      pinnedGet('http://tenant.test:18812/start', { timeoutMs: 5000, maxRedirects: 3 }),
    ).rejects.toThrow('redirect budget');
    expect(hits).toBe(4); // initial request + 3 followed hops
  });

  it('leaves unpinned hostnames on plain fetch', async () => {
    const seen = { host: null as string | null };
    await serveEcho('127.0.0.1', 18804, seen);
    const response = await pinnedGet('http://127.0.0.1:18804/direct', { timeoutMs: 5000 });
    expect(response.status).toBe(200);
    expect(seen.host).toBe('127.0.0.1:18804');
  });
});

describe('browser manager DNS pinning', () => {
  it('passes resolver rules to the Chromium launch', async () => {
    let launched: Record<string, unknown> | null = null;
    const recording = {
      launch: async (options?: Record<string, unknown>) => {
        launched = options ?? null;
        return {
          newContext: async () => ({ newPage: async () => ({}), close: async () => undefined }),
          close: async () => undefined,
        } as never;
      },
    };
    const manager = new EngineBrowserManager(recording);
    manager.setDnsPinRules('MAP tenant.test 127.0.0.1');
    await manager.pageFor('session-1');
    expect(launched).toMatchObject({ headless: true });
    expect((launched as unknown as Record<string, unknown>)['args']).toEqual([
      '--host-resolver-rules=MAP tenant.test 127.0.0.1',
    ]);
    await manager.closeAll();
  });

  it('launches plainly with no pins and refuses late pinning', async () => {
    let launched: Record<string, unknown> | null = null;
    const recording = {
      launch: async (options?: Record<string, unknown>) => {
        launched = options ?? null;
        return {
          newContext: async () => ({ newPage: async () => ({}), close: async () => undefined }),
          close: async () => undefined,
        } as never;
      },
    };
    const manager = new EngineBrowserManager(recording);
    await manager.pageFor('session-1');
    expect(launched).toEqual({ headless: true });
    expect(() => manager.setDnsPinRules('MAP tenant.test 127.0.0.1')).toThrow(
      'pins must precede every navigation',
    );
    await manager.closeAll();
  });
});

describe('real Chromium DNS binding (acceptance)', () => {
  /**
   * Acceptance (GF-10): the injected-launcher tests above prove the
   * launch ARGS; these cases prove the BINDING through a real Chromium:
   * a hostname with no DNS record at all reaches the approved loopback
   * service (only the pinned resolver rule can answer it) and the
   * service receives the tenant Host header — routing preserved. An
   * unpinned, unresolvable name still fails: the rules never widen
   * reachability.
   */
  it('routes a tenant hostname to the approved loopback service through real Chromium', async () => {
    const seen: { host: string | null; paths: string[] } = { host: null, paths: [] };
    const server = createServer((req, res) => {
      seen.host = req.headers.host ?? null;
      seen.paths.push(req.url ?? '');
      res.end('<html><body>tenant-ok</body></html>');
    });
    await new Promise<void>((done) => server.listen(18820, '127.0.0.5', () => done()));
    await pinLoopbackIps('chromium-tenant.test', async () => [{ address: '127.0.0.5', family: 4 }]);
    const manager = new EngineBrowserManager(chromium);
    manager.setDnsPinRules(hostResolverRules() ?? '');
    try {
      const page = await manager.pageFor('acceptance-session');
      const response = await page.goto('http://chromium-tenant.test:18820/tenant-path', {
        timeout: 20_000,
      });
      expect(response?.status()).toBe(200);
      expect(await page.textContent('body')).toContain('tenant-ok');
      // The approved loopback service saw the tenant hostname (tenant
      // routing intact) at the pinned IP — through real Chromium DNS
      // resolution, not a test double.
      expect(seen.host).toBe('chromium-tenant.test:18820');
      expect(seen.paths).toEqual(['/tenant-path']);
    } finally {
      await manager.closeAll();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('cannot resolve an unpinned, unresolvable name through real Chromium', async () => {
    await pinLoopbackIps('chromium-tenant.test', async () => [{ address: '127.0.0.5', family: 4 }]);
    const manager = new EngineBrowserManager(chromium);
    manager.setDnsPinRules(hostResolverRules() ?? '');
    try {
      const page = await manager.pageFor('acceptance-negative');
      // '.invalid' is guaranteed non-resolving (RFC 2606/6761) and the
      // pins do not cover it: navigation must fail instead of silently
      // reaching anything.
      await expect(
        page.goto('http://unmapped.invalid:18820/', { timeout: 20_000 }),
      ).rejects.toThrow();
    } finally {
      await manager.closeAll();
    }
  });
});
