/**
 * Resolving loopback attestation tests (GF-10 hostname fix): the sync
 * string check is unchanged, and hostnames that resolve entirely to
 * loopback addresses (tenant subdomains mapped to 127.0.0.1 in the
 * hosts file — the disposable-stack pattern) attest via the OS
 * resolver. Mixed records, public addresses, unresolvable names, and
 * lookup failures all reject (fail closed). Resolutions are cached per
 * hostname for the process lifetime.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  AttestationError,
  clearLoopbackCacheForTests,
  isLoopbackUrl,
  isLoopbackUrlResolving,
  assertLoopback,
  type DnsLookup,
} from '../src/witness/env-attestation.js';

beforeEach(() => {
  clearLoopbackCacheForTests();
});

describe('sync string loopback check (unchanged)', () => {
  it('accepts literal loopback hosts', () => {
    expect(isLoopbackUrl('http://localhost:13001')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:18000')).toBe(true);
    expect(isLoopbackUrl('http://127.1.2.3:9')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:3000')).toBe(true);
    expect(isLoopbackUrl('http://0.0.0.0:8000')).toBe(true);
  });

  it('rejects non-loopback names without resolving', () => {
    expect(isLoopbackUrl('http://aetherios.estatemind.loc:13001')).toBe(false);
    expect(isLoopbackUrl('http://example.com/')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});

describe('resolving loopback check', () => {
  const loopbackOnly: DnsLookup = async () => [{ address: '127.0.0.1', family: 4 }];
  const publicOnly: DnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const mixed: DnsLookup = async () => [
    { address: '127.0.0.1', family: 4 },
    { address: '93.184.216.34', family: 4 },
  ];
  const failing: DnsLookup = async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND x.invalid'), { code: 'ENOTFOUND' });
  };
  const empty: DnsLookup = async () => [];

  it('accepts a hostname resolving entirely to loopback', async () => {
    expect(await isLoopbackUrlResolving('http://aetherios.estatemind.loc:13001', loopbackOnly)).toBe(true);
  });

  it('accepts ::1-only resolutions', async () => {
    const v6: DnsLookup = async () => [{ address: '::1', family: 6 }];
    expect(await isLoopbackUrlResolving('http://tenant.test:13001', v6)).toBe(true);
  });

  it('rejects public, mixed, empty, and failed resolutions', async () => {
    expect(await isLoopbackUrlResolving('http://example.com/', publicOnly)).toBe(false);
    expect(await isLoopbackUrlResolving('http://example.com/', mixed)).toBe(false);
    expect(await isLoopbackUrlResolving('http://example.com/', empty)).toBe(false);
    expect(await isLoopbackUrlResolving('http://x.invalid/', failing)).toBe(false);
  });

  it('rejects non-http(s) URLs without resolving', async () => {
    let called = 0;
    const counting: DnsLookup = async () => {
      called += 1;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    expect(await isLoopbackUrlResolving('ftp://aetherios.estatemind.loc/x', counting)).toBe(false);
    expect(called).toBe(0);
  });

  it('caches the verdict per hostname (one lookup per process lifetime)', async () => {
    let called = 0;
    const counting: DnsLookup = async () => {
      called += 1;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    expect(await isLoopbackUrlResolving('http://aetherios.estatemind.loc:13001', counting)).toBe(true);
    expect(await isLoopbackUrlResolving('http://aetherios.estatemind.loc:18000', counting)).toBe(true);
    expect(called).toBe(1);
  });

  it('resolves through the real OS resolver for localhost', async () => {
    expect(await isLoopbackUrlResolving('http://localhost:13001')).toBe(true);
  });
});

describe('assertLoopback (async contract)', () => {
  it('passes literal and resolving loopback bases', async () => {
    await assertLoopback('http://127.0.0.1:18000', 'adapter');
    await assertLoopback(
      'http://aetherios.estatemind.loc:13001',
      'attestation subject',
    );
  });

  it('throws AttestationError naming the base for public hosts', async () => {
    // example.com resolves publicly (or fails to resolve offline) —
    // either path rejects, and the error names the offending base.
    await expect(assertLoopback('http://example.com/', "adapter 'x'")).rejects.toThrow(AttestationError);
    await expect(assertLoopback('http://example.com/', "adapter 'x'")).rejects.toThrow(
      "adapter 'x' base 'http://example.com/' is not loopback",
    );
  });
});
