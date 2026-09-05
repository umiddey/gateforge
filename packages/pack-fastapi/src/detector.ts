/**
 * The pack's discover entry: a thin TypeScript GPP/3 client over the
 * Python AST detector, usable from BOTH CLI transports (the pack-sqlalchemy
 * pattern; see ADR 0002 for the two-tier boundary).
 *
 * - **in-process**: `.gateforge.yml` declares
 *   `transport: in-process, module: "@gateforge/pack-fastapi"`; the CLI
 *   imports this package's default export and calls `discover(paths)`.
 *   The implementation spawns the SAME python detector (GPP/3, hardened
 *   host) with a computed `PYTHONPATH`, so one detector implementation
 *   serves both transports.
 * - **subprocess**: `.gateforge.yml` declares
 *   `transport: subprocess, command: ["python3","-m","gateforge_fastapi_detector"]`
 *   (with the pack's `python/` dir on `PYTHONPATH`); the CLI drives the
 *   plugin directly — see the README.
 *
 * Post-processing (`facts.ts`): effective paths are canonicalized with the
 * shared `@gateforge/http-contract` rules. The wrapper mints NO
 * classification signals (dogfood remediation phase 4): a path-derived
 * target is a guess that mostly names no discovered resource — route→resource
 * linkage is the CLI endpoint compiler's exclusive job (schema-symbol/
 * handler corroboration over the facts this pack emits).
 *
 * Determinism: the python scan is pure over (paths, file bytes). The
 * optional `.gateforge/fastapi.json` config (import roots for absolute
 * imports, the central-router-registry pattern) is read once at factory
 * time and passed to the scanner as an explicit `--import-roots` argv
 * flag — never environment state, never per-request mutation.
 */
import { readFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginSession, type DiscoveryOutcome } from '@gateforge/plugin-protocol';
import { canonicalizeFacts, type ContractResource } from './facts.js';
import { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';

/** Absolute dir of this pack's `python/` tree (the detector package). */
const PACK_PYTHON_DIR = fileURLToPath(new URL('../python', import.meta.url));

/** Absolute dir of the sibling `@gateforge/plugin-protocol` python client. */
const PROTOCOL_PYTHON_DIR = fileURLToPath(
  new URL('../../../plugin-protocol/python', import.meta.url),
);

/** The subprocess command the in-process transport spawns (G4 surface). */
export const DEFAULT_COMMAND = ['python3', '-m', 'gateforge_fastapi_detector'];

/**
 * The detector's config channel: a JSON document read from the repo root
 * (same precedent as pack-http's `.gateforge/http-clients.json`). Absence
 * is normal; a malformed document throws (fail closed).
 */
export const FASTAPI_SCAN_CONFIG_PATH = '.gateforge/fastapi.json';

/** Parsed `.gateforge/fastapi.json` document (strict schema). */
export interface FastapiScanConfig {
  /**
   * Repo-root-relative directories that act as Python import roots for
   * ABSOLUTE imports — the central-router-registry pattern
   * (`from api.v1.endpoints import activities` +
   * `app.include_router(activities.router, prefix=...)`). Resolution is
   * unique or typed-unresolved: an import matching more than one scanned
   * file across the roots never guesses.
   */
  importRoots?: readonly string[];
}

export const DEFAULT_FASTAPI_SCAN_CONFIG: FastapiScanConfig = {};

/** One repo-relative import root, validated (fail closed on malformed). */
function normalizeImportRoot(raw: unknown, path: string): string {
  if (typeof raw !== 'string') {
    throw new Error(
      `invalid fastapi detector config: import roots must be strings at ${path}`,
    );
  }
  const stripped = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  let normalized = stripped;
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  const segments = normalized.split('/');
  if (normalized === '' || normalized.startsWith('/') || segments.includes('..')) {
    throw new Error(
      `invalid fastapi detector config: import root must be a repo-root-relative ` +
        `directory at ${path}: ${JSON.stringify(raw)}`,
    );
  }
  return normalized;
}

/**
 * Reads a fastapi detector config document. Returns the default config
 * when the file is absent; malformed documents throw (fail closed — the
 * CLI surfaces the error instead of scanning with partial trust).
 */
export function readFastapiScanConfigOrNull(path: string | null): FastapiScanConfig {
  if (path === null) return DEFAULT_FASTAPI_SCAN_CONFIG;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return DEFAULT_FASTAPI_SCAN_CONFIG; // absence is normal; malformed is not (below)
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid fastapi detector config: expected an object at ${path}`);
  }
  const document = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(document).filter((key) => key !== 'importRoots');
  if (unknownKeys.length > 0) {
    // Strict on purpose: a typo'd key would otherwise silently disable the
    // import roots and hide exactly the routes they exist to expose.
    throw new Error(
      `invalid fastapi detector config: unknown key(s) ` +
        `${unknownKeys.sort().join(', ')} at ${path}`,
    );
  }
  const config: FastapiScanConfig = {};
  const roots = document['importRoots'];
  if (roots !== undefined) {
    if (!Array.isArray(roots)) {
      throw new Error(
        `invalid fastapi detector config: 'importRoots' must be an array of ` +
          `repo-root-relative directories at ${path}`,
      );
    }
    config.importRoots = roots.map((root) => normalizeImportRoot(root, path));
  }
  return config;
}

/**
 * Builds the environment the python detector runs under: the host env
 * plus a `PYTHONPATH` that makes both this pack's detector and the GPP/3
 * client importable.
 */
export function pythonEnvironment(extra: readonly string[] = []): NodeJS.ProcessEnv {
  const entries = [...extra, PACK_PYTHON_DIR, PROTOCOL_PYTHON_DIR];
  return { ...process.env, PYTHONPATH: entries.join(delimiter) };
}

/** Options for {@link createFastapiDetector}. */
export interface FastapiDetectorOptions {
  /** Subprocess argv (default: `python3 -m gateforge_fastapi_detector`). */
  command?: readonly string[];
  /** Subprocess environment (default: {@link pythonEnvironment}). */
  env?: NodeJS.ProcessEnv;
  /** Working directory the repo-relative paths resolve against. */
  cwd?: string;
  /** Handshake-pinned plugin id (default: the pack id). */
  pluginId?: string;
  /** Handshake-pinned plugin version (default: the pack version). */
  pluginVersion?: string;
  /**
   * Explicit import roots (repo-root-relative); overrides the config
   * document entirely when given.
   */
  importRoots?: readonly string[];
  /**
   * Repo-relative path of a config document (JSON) read from `cwd` when
   * `importRoots` is not given (default: `.gateforge/fastapi.json`;
   * absence is normal, malformed throws).
   */
  importRootsConfigPath?: string;
}

/** The pinned in-process plugin contract: `{ discover(paths) }`. */
export interface FastapiDetector {
  discover(
    paths: readonly string[],
  ): Promise<{
    resources: unknown[];
    unresolved: unknown[];
    findings: unknown[];
    classificationSignals: unknown[];
    scannedPaths?: string[];
  }>;
}

/**
 * Creates a discover-capable detector module. The default export of the
 * pack is `createFastapiDetector()` — the CLI in-process contract.
 */
export function createFastapiDetector(options: FastapiDetectorOptions = {}): FastapiDetector {
  const command = options.command ?? DEFAULT_COMMAND;
  const env = options.env ?? pythonEnvironment();
  const cwd = options.cwd ?? process.cwd();
  const pluginId = options.pluginId ?? PACK_PLUGIN_ID;
  const pluginVersion = options.pluginVersion ?? PACK_VERSION;
  // Explicit roots win; otherwise the config document (absence normal,
  // malformed throws). With no roots at all the spawned command is
  // byte-identical to the pre-config surface.
  const importRoots =
    options.importRoots ??
    readFastapiScanConfigOrNull(resolve(cwd, options.importRootsConfigPath ?? FASTAPI_SCAN_CONFIG_PATH))
      .importRoots ??
    [];
  const argv =
    importRoots.length > 0 ? [...command, '--import-roots', JSON.stringify(importRoots)] : [...command];

  return {
    async discover(paths) {
      if (paths.length === 0) {
        return { resources: [], unresolved: [], findings: [], classificationSignals: [] };
      }
      const session = new PluginSession({
        command: argv,
        pluginId,
        pluginVersion,
        cwd,
        env,
        timeouts: { handshakeMs: 10_000, requestMs: 30_000, shutdownMs: 10_000 },
      });
      try {
        await session.start();
        const outcome = await session.discover([...paths]);
        return postprocess(outcome);
      } finally {
        await session.dispose();
      }
    },
  };
}

/**
 * Canonicalizes facts and merges the wrapper's unresolved entries with the
 * python scanner's, keeping the whole outcome deterministic.
 */
function postprocess(outcome: DiscoveryOutcome): DiscoveryOutcome {
  const canonical = canonicalizeFacts(outcome.resources as readonly ContractResource[]);
  const unresolved = [
    ...outcome.unresolved,
    ...canonical.unresolved,
  ].sort((a, b) => {
    const locationA = a['location'] as { file: string; line: number } | undefined;
    const locationB = b['location'] as { file: string; line: number } | undefined;
    const fileA = locationA?.['file'] ?? '';
    const fileB = locationB?.['file'] ?? '';
    if (fileA !== fileB) return fileA < fileB ? -1 : 1;
    const lineA = locationA?.['line'] ?? 0;
    const lineB = locationB?.['line'] ?? 0;
    if (lineA !== lineB) return lineA - lineB;
    const codeA = String(a['code'] ?? '');
    const codeB = String(b['code'] ?? '');
    if (codeA !== codeB) return codeA < codeB ? -1 : 1;
    const detailA = String(a['detail'] ?? '');
    const detailB = String(b['detail'] ?? '');
    if (detailA === detailB) return 0;
    return detailA < detailB ? -1 : 1;
  });
  return {
    resources: canonical.resources,
    unresolved,
    findings: outcome.findings,
    classificationSignals: canonical.classificationSignals,
    ...(outcome.scannedPaths !== undefined ? { scannedPaths: outcome.scannedPaths } : {}),
  };
}
