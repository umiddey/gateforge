import { describe, expect, it } from 'vitest';
import { hostLoadFailureNotices, type HostLoadSample } from '../src/host-load.js';

describe('host-load failure notices', () => {
  it('annotates only failed tests above the load threshold at their completion time', () => {
    const samples: HostLoadSample[] = [
      {
        timestamp: '2026-09-27T10:00:00.000Z',
        loadAverage: [25, 20, 18],
        cpuCount: 16,
        freeDiskBytes: 1_000,
        totalDiskBytes: 10_000,
        freeDiskPercent: 10,
      },
      {
        timestamp: '2026-09-27T10:01:00.000Z',
        loadAverage: [18, 18, 18],
        cpuCount: 16,
        freeDiskBytes: 1_000,
        totalDiskBytes: 10_000,
        freeDiskPercent: 10,
      },
    ];
    expect(hostLoadFailureNotices(samples, [
      { file: 'tests/slow.spec.ts', titlePath: ['slow check'], status: 'failed', finishedAt: '2026-09-27T10:00:30.000Z' },
      { file: 'tests/fast.spec.ts', titlePath: ['fast check'], status: 'failed', finishedAt: '2026-09-27T10:01:30.000Z' },
      { file: 'tests/passing.spec.ts', titlePath: ['passed'], status: 'passed', finishedAt: '2026-09-27T10:00:30.000Z' },
    ])).toEqual(['tests/slow.spec.ts > slow check: load 25.0 on 16 CPUs']);
  });
});
