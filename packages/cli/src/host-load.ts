import { mkdirSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';

export interface HostLoadSample {
  timestamp: string;
  loadAverage: number[];
  cpuCount: number;
  freeDiskBytes: number;
  totalDiskBytes: number;
  freeDiskPercent: number;
}

export interface HostLoadCollector {
  stop: () => HostLoadSample[];
}

/** Reads load averages, CPU count, and free space for the state directory's filesystem.
 *
 * Args:
 *   stateDir: run-state directory used to select the filesystem.
 *   timestamp: sample timestamp, defaulting to the current time.
 *
 * Returns:
 *   HostLoadSample: point-in-time host diagnostics.
 */
export function sampleHostLoad(stateDir: string, timestamp = new Date().toISOString()): HostLoadSample {
  const disk = statfsSync(stateDir);
  const totalDiskBytes = Number(disk.blocks) * Number(disk.bsize);
  const freeDiskBytes = Number(disk.bavail) * Number(disk.bsize);
  return {
    timestamp,
    loadAverage: loadavg(),
    cpuCount: cpus().length,
    freeDiskBytes,
    totalDiskBytes,
    freeDiskPercent: totalDiskBytes === 0 ? 0 : (freeDiskBytes / totalDiskBytes) * 100,
  };
}

/** Collects host samples at run start, every thirty seconds, and at stop.
 *
 * Args:
 *   stateDir: run-state directory where diagnostics are written.
 *   onWarning: optional callback for low-disk warnings.
 *
 * Returns:
 *   { stop }: finalizes the JSON artifact and stops the sampling timer.
 */
export function startHostLoadSampler(
  stateDir: string,
  onWarning: (message: string) => void = () => undefined,
): HostLoadCollector {
  const samples = [sampleHostLoad(stateDir)];
  if (samples[0]!.freeDiskPercent < 5) onWarning(`free disk space is ${samples[0]!.freeDiskPercent.toFixed(1)}%`);
  const timer = setInterval(() => samples.push(sampleHostLoad(stateDir)), 30_000);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      samples.push(sampleHostLoad(stateDir));
      const directory = join(stateDir, 'diagnostics');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'host-load.json'), `${JSON.stringify({ samples }, null, 2)}\n`, 'utf8');
      return samples;
    },
  };
}
