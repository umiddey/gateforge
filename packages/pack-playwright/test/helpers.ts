/**
 * Shared helpers for the pack's vitest suites (engine + playwright-
 * evidence + example-e2e classes per docs/testing/TESTING_POLICY.md).
 *
 * Everything runs against TEMP projects under the OS tmpdir (never the
 * gateforge repo's own state), with injected clocks, loopback servers,
 * and zero network. The example app + attestation proxy + witness +
 * `gateforge test-gates` are all driven as real processes/loopback
 * services — no mocks in the evidence path.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root (the gateforge monorepo). */
export const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Absolute path of the compiled CLI bin. */
export const CLI_BIN = join(ROOT, 'packages/cli/bin/gateforge.js');

/** Absolute path of the example app entry. */
export const EXAMPLE_SERVER = join(ROOT, 'example/server.js');

/** Absolute path of the compiled playwright CLI (1.58.2 pin). */
export const PLAYWRIGHT_CLI = join(ROOT, 'node_modules/playwright/cli.js');

/** Absolute path of the pack's compiled reporter module. */
export const PACK_REPORTER = join(ROOT, 'packages/pack-playwright/dist/reporter/reporter.js');

/** Absolute path of the pack's dist directory. */
export const PACK_DIST = join(ROOT, 'packages/pack-playwright/dist');

/** Injected clock used by every temp `.gateforge.yml` (invariant 7). */
export const FIXED_AT = '2026-08-30T12:00:00.000Z';

/** The env fingerprint the attestation proxy stamps in fixture runs. */
export const FINGERPRINT = 'example-v1';

/** Result of a completed child-process run. */
export interface SpawnOutcome {
	status: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
}

/** Runs one command to completion (captured, max 64 MiB each stream). */
export function run(
	command: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): SpawnOutcome {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? ROOT,
		env: { ...process.env, ...(options.env ?? {}) },
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		timeout: options.timeoutMs ?? 120_000,
	});
	return {
		status: result.status,
		signal: result.signal,
		stdout: (result.stdout as string | null) ?? '',
		stderr: (result.stderr as string | null) ?? '',
	};
}

/** Builds the pack's dist (required before any Playwright run). */
export function buildPack(): SpawnOutcome {
	return run('npx', ['tsc', '-p', 'packages/pack-playwright/tsconfig.build.json'], {
		cwd: ROOT,
		timeoutMs: 180_000,
	});
}

/** Creates a disposable temp project and returns its absolute path. */
export function makeTempProject(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `gateforge-${label}-`));
	mkdirSync(join(dir, '.gateforge/adapters'), { recursive: true });
	mkdirSync(join(dir, '.gateforge/waivers'), { recursive: true });
	mkdirSync(join(dir, '.gateforge/baselines'), { recursive: true });
	mkdirSync(join(dir, '.gateforge/test-gates'), { recursive: true });
	mkdirSync(join(dir, 'src'), { recursive: true });
	mkdirSync(join(dir, 'specs'), { recursive: true });
	// Link the monorepo's node_modules so specs resolve
	// '@gateforge/pack-playwright' and 'playwright'.
	symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
	writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
	writeFileSync(join(dir, 'src/accounts.js'), '// fixture source: the accounts resource lives here.\n');
	return dir;
}

/** Cleans a temp project (best-effort; never touches the repo). */
export function removeTempProject(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

/**
 * Writes the full `.gateforge` fixture project: config, in-process
 * detector, classifications, policies, baseline, and a placeholder
 * source file. The in-process detector declares one resource
 * (`accounts`, kind `fixture.entity`) that the graph normalizes to
 * `tenant.accounts` via the classifications plane.
 */
export function writeFixtureProject(
	dir: string,
	lifecycle: {
		create: boolean;
		read: boolean;
		update: boolean;
		delete: boolean;
		deleteSemantics?: 'hard' | 'archive';
	} = { create: true, read: true, update: true, delete: true, deleteSemantics: 'archive' },
): void {
	writeFileSync(
		join(dir, '.gateforge.yml'),
		[
			'schemaVersion: 1',
			'project:',
			'  languages: [javascript]',
			"  paths: { include: ['src/**'], exclude: [] }",
			'plugins:',
			'  - id: gateforge.fixture',
			'    version: 1.0.0',
			'    transport: in-process',
			'    module: ./.gateforge/fixture-detector.mjs',
			'policies: .gateforge/policies.yml',
			'classifications: .gateforge/classifications.yml',
			'adapters: .gateforge/adapters',
			'waivers: .gateforge/waivers',
			'baselines: .gateforge/baselines/obligations.json',
			'changed: { provider: auto }',
			'witness: { maxDurationSeconds: 5 }',
			`clock: { mode: fixed, fixedAt: '${FIXED_AT}' }`,
			'',
		].join('\n'),
	);
	writeFileSync(
		join(dir, '.gateforge/fixture-detector.mjs'),
		[
			'// In-process fixture detector: declares the accounts resource',
			'// exactly as a reviewed detector would (the resource graph',
			'// normalizes `accounts` + plane `tenant` to `tenant.accounts`).',
			'export default {',
			'  async discover() {',
			'    return {',
			'      resources: [{',
			'        schemaVersion: 1,',
			"        id: 'accounts',",
			"        kind: 'fixture.entity',",
			"        source: 'src/accounts.js',",
			"        location: { file: 'src/accounts.js', line: 1, col: 0 },",
			"        detectorVersion: '1.0.0',",
			"        attributes: { resourceName: 'accounts' },",
			'      }],',
			'      unresolved: [],',
			'      findings: [],',
			'    };',
			'  },',
			'};',
			'',
		].join('\n'),
	);
	writeFileSync(
		join(dir, '.gateforge/policies.yml'),
		[
			'schemaVersion: 1',
			'policies:',
			'  - id: crud',
			'    when: {}',
			'    require: [crud:create, crud:read, crud:update, crud:delete]',
			'',
		].join('\n'),
	);
	const lifecycleLines = [
		`      create: ${lifecycle.create}`,
		`      read: ${lifecycle.read}`,
		`      update: ${lifecycle.update}`,
		`      delete: ${lifecycle.delete}`,
	];
	if (lifecycle.delete) {
		lifecycleLines.push(`      deleteSemantics: ${lifecycle.deleteSemantics ?? 'archive'}`);
	}
	writeFileSync(
		join(dir, '.gateforge/classifications.yml'),
		[
			'schemaVersion: 1',
			'resources:',
			'  accounts:',
			'    exposure: user-facing',
			'    plane: tenant',
			'    lifecycle:',
			...lifecycleLines,
			'    primaryKey: [id]',
			'    evidenceAdapter: tenant.accounts',
			'',
		].join('\n'),
	);
	writeFileSync(
		join(dir, '.gateforge/baselines/obligations.json'),
		`${JSON.stringify({ schemaVersion: 1, fingerprints: [] }, null, 2)}\n`,
	);
}

/** Writes the HONEST adapter for `tenant.accounts` into a temp project. */
export function writeHonestAdapter(dir: string, fingerprint = FINGERPRINT): void {
	writeFileSync(
		join(dir, '.gateforge/adapters/tenant.accounts.mjs'),
		[
			'// Reviewed evidence adapter for tenant.accounts (GET-only).',
			'export default {',
			'  async read(ctx, id) {',
			'    const res = await ctx.get(`/api/accounts/${encodeURIComponent(String(id))}`);',
			'    if (res.status === 404) return null;',
			'    if (res.status !== 200) throw new Error(`adapter read failed: HTTP ${res.status}`);',
			'    return res.json();',
			'  },',
			'  normalize(body) {',
			'    return {',
			'      entityId: body.id,',
			'      fields: { first_name: body.first_name, last_name: body.last_name, status: body.status },',
			'    };',
			'  },',
			"  deletion: 'archive',",
			`  environmentFingerprint: '${fingerprint}',`,
			'};',
			'',
		].join('\n'),
	);
}

/** Writes the wrong-entity adapter (GF-05: ignores the requested id). */
export function writeWrongEntityAdapter(dir: string, fingerprint = FINGERPRINT): void {
	writeFileSync(
		join(dir, '.gateforge/adapters/tenant.accounts.mjs'),
		[
			'// Adversarial adapter: ALWAYS returns account acc-3 regardless of',
			'// the requested entity id (genuine evidence for the wrong entity).',
			'export default {',
			'  async read(ctx) {',
			'    const res = await ctx.get("/api/accounts/acc-3");',
			'    if (res.status === 404) return null;',
			'    if (res.status !== 200) throw new Error(`adapter read failed: HTTP ${res.status}`);',
			'    return res.json();',
			'  },',
			'  normalize(body) {',
			'    return {',
			'      entityId: body.id,',
			'      fields: { first_name: body.first_name, last_name: body.last_name, status: body.status },',
			'    };',
			'  },',
			"  deletion: 'archive',",
			`  environmentFingerprint: '${fingerprint}',`,
			'};',
			'',
		].join('\n'),
	);
}

/**
 * Starts the example app as a child; resolves its loopback URL.
 *
 * Returns:
 *   Promise<{url, stop}>: the app URL once listening (stop kills the
 *   child with SIGTERM).
 */
export async function startExampleApp(): Promise<{ url: string; stop: () => void }> {
	const child = spawn(process.execPath, [EXAMPLE_SERVER], {
		cwd: dirname(EXAMPLE_SERVER),
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	const url = await new Promise<string>((resolveUrl, rejectUrl) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			rejectUrl(new Error('example app did not report its URL in time'));
		}, 15_000);
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
			const match = /listening on (http:\/\/\S+)/.exec(stdout);
			if (match !== null) {
				clearTimeout(timer);
				resolveUrl(match[1] as string);
			}
		});
		child.once('error', (error) => {
			clearTimeout(timer);
			rejectUrl(error);
		});
		child.once('exit', (code) => {
			clearTimeout(timer);
			rejectUrl(new Error(`example app exited early (code ${String(code)}): ${stdout}`));
		});
	});
	return {
		url,
		stop: () => {
			child.kill('SIGTERM');
		},
	};
}

/** Reads a JSON file (null when absent/broken). */
export function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as unknown;
	} catch {
		return null;
	}
}

export { resolve };