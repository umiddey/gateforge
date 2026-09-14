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
import { createServer, request as httpRequest } from 'node:http';

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
 * detector, automatic classification policy, policies, baseline, and a
 * placeholder source file. The detector emits source-located GPP/3 facts
 * and core derives the effective classification.
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
			'classificationPolicy: .gateforge/classification-policy.yml',
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
			'// In-process fixture detector: declares the accounts resource and',
			'// emits only normalized GPP/3 classification facts.',
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
			"        attributes: { resourceName: 'accounts', updateableFields: ['first_name', 'last_name', 'status'] },",
			'      }],',
			'      unresolved: [],',
			'      findings: [],',
			'      classificationSignals: [',
			'        { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "plane", assertion: "tenant", basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },',
			'        { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "identity", assertion: ["id"], basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },',
			'        { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "adapter-binding", assertion: "tenant.accounts", basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },',
			`        { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "lifecycle.create", assertion: ${String(lifecycle.create)}, basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },`,
			`        { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "lifecycle.read", assertion: ${String(lifecycle.read)}, basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },`,
			`        { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "lifecycle.update", assertion: ${String(lifecycle.update)}, basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },`,
			`        { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "lifecycle.delete", assertion: ${String(lifecycle.delete)}, basis: "${lifecycle.delete ? 'declaration' : 'code-negative-closed-world'}", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } }${lifecycle.delete ? ',' : ''}`,
			...(lifecycle.delete
				? [
						'        { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "delete-semantics", assertion: "archive", basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },',
						'        { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "archive-state", assertion: { status: "archived" }, basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },',
					]
				: []),
			'      ],',
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
			'    require: [persistence:create, persistence:read, persistence:update, persistence:delete]',
			'',
		].join('\n'),
	);
	writeFileSync(
		join(dir, '.gateforge/classification-policy.yml'),
		[
			'schemaVersion: 1',
			"scanRoots: ['src/**']",
			'trustedInternalEntryPoints: []',
			'internalRules: []',
			'declarations:',
			'  internality: gateforge:internal',
			'volatileFields: []',
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
		lifecycleLines.push(
			`      deleteSemantics: ${lifecycle.deleteSemantics ?? 'archive'}`,
			'      archiveFields: { status: archived }',
		);
	}
	writeFileSync(
		join(dir, '.gateforge/effective-classifications.yml'),
		[
			'schemaVersion: 1',
			'resources:',
			'  tenant.accounts:',
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
			'  async list(ctx) {',
			'    const res = await ctx.get(\'/api/accounts\');',
			'    if (res.status !== 200) throw new Error(`adapter list failed: HTTP ${res.status}`);',
			'    const body = await res.json();',
			'    return body.accounts;',
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

// ---------------------------------------------------------------------------
// Phase 1 session helpers: tests act as their own TRUSTED SUPERVISOR when
// they drive the witness directly (the same /sessions channel the pack
// reporter drives in real runs).
// ---------------------------------------------------------------------------

/** A supervisor-opened session credential (the witness-issued binding). */
export interface SupervisorSession {
	sessionId: string;
	sessionToken: string;
	testId: string;
	workerIndex: number;
	openedTick: number;
	/** The session's dedicated observation-proxy origin (null when no proxy). */
	proxyUrl: string | null;
}

/**
 * Opens a test session the way the trusted supervisor (the CLI's spool
 * drain) does in real runs (enforcement-review fix 3): the session
 * lifecycle is verifier-key authenticated, so tests acting as the
 * supervisor present the verifier key — the run token alone answers 403.
 *
 * Args:
 *   witnessUrl: the witness base URL.
 *   token: the run token.
 *   testId: the runner-assigned test id to bind.
 *   workerIndex: the worker the test runs on (default 0).
 *   verifierKey: the witness verifier key (the supervisor capability;
 *     omit only in negative tests that assert the 403).
 *   claims: optional supervisor-carried obligation claims (Phase 4 claim
 *     injection — what the orchestrating CLI drains from the sidecar in
 *     real runs).
 *
 * Returns:
 *   SupervisorSession: the session binding (credential + proxy prefix).
 */
export async function openSupervisorSession(
	witnessUrl: string,
	token: string,
	testId: string,
	workerIndex = 0,
	verifierKey?: string,
	claims?: readonly string[],
): Promise<SupervisorSession> {
	const res = await fetch(`${witnessUrl}/sessions/open`, {
		method: 'POST',
		headers: {
			'x-gateforge-run': token,
			...(verifierKey !== undefined ? { 'x-gateforge-verifier': verifierKey } : {}),
			'content-type': 'application/json',
		},
		body: JSON.stringify({ testId, workerIndex, ...(claims !== undefined ? { claims } : {}) }),
	});
	if (!res.ok) {
		throw new Error(`sessions/open answered ${res.status}: ${await res.text()}`);
	}
	return (await res.json()) as SupervisorSession;
}

/**
 * Closes (seals) a supervisor-opened session with the observed outcome
 * (verifier-key authenticated — see {@link openSupervisorSession}).
 */
export async function closeSupervisorSession(
	witnessUrl: string,
	token: string,
	sessionId: string,
	outcome = 'passed',
	verifierKey?: string,
): Promise<void> {
	const res = await fetch(`${witnessUrl}/sessions/close`, {
		method: 'POST',
		headers: {
			'x-gateforge-run': token,
			...(verifierKey !== undefined ? { 'x-gateforge-verifier': verifierKey } : {}),
			'content-type': 'application/json',
		},
		body: JSON.stringify({ sessionId, outcome }),
	});
	if (!res.ok) {
		throw new Error(`sessions/close answered ${res.status}: ${await res.text()}`);
	}
}

/** Marks the start of a UI-action observation interval (witness clock). */
export async function beginJourneyInterval(
	witnessUrl: string,
	token: string,
	session: SupervisorSession,
	operation = 'create',
): Promise<string> {
	const res = await fetch(`${witnessUrl}/sessions/intervals/open`, {
		method: 'POST',
		headers: { 'x-gateforge-run': token, 'content-type': 'application/json' },
		body: JSON.stringify({
			sessionId: session.sessionId,
			sessionToken: session.sessionToken,
			operation,
		}),
	});
	if (!res.ok) {
		throw new Error(`sessions/intervals/open answered ${res.status}: ${await res.text()}`);
	}
	const body = (await res.json()) as { intervalId: string };
	return body.intervalId;
}

/** Seals a UI-action observation interval. */
export async function endJourneyInterval(
	witnessUrl: string,
	token: string,
	session: SupervisorSession,
	intervalId: string,
): Promise<void> {
	const res = await fetch(`${witnessUrl}/sessions/intervals/close`, {
		method: 'POST',
		headers: { 'x-gateforge-run': token, 'content-type': 'application/json' },
		body: JSON.stringify({
			sessionId: session.sessionId,
			sessionToken: session.sessionToken,
			intervalId,
		}),
	});
	if (!res.ok) {
		throw new Error(`sessions/intervals/close answered ${res.status}: ${await res.text()}`);
	}
}

/**
 * Copies the checked-in consumer surface descriptor
 * (example/e2e/accounts-surface.js) into a temp project as CONSUMER-SIDE
 * code — exactly how a real consumer ships its surface next to its specs.
 */
export function writeAccountsSurface(dir: string): void {
	const surface = readFileSync(join(ROOT, 'example/e2e/accounts-surface.js'), 'utf8');
	writeFileSync(join(dir, 'specs/accounts-surface.js'), surface);
}

/**
 * Writes an ADVERSARIAL adapter whose backend observation never finds
 * the entity (probe: a broken backend operation — HTTP transport may
 * look fine, but the engine-observed state read reports absence).
 */
export function writeAbsentAdapter(dir: string, fingerprint = FINGERPRINT): void {
	writeFileSync(
		join(dir, '.gateforge/adapters/tenant.accounts.mjs'),
		[
			'// Adversarial adapter: the engine-side state read always reports',
			"// the entity ABSENT (a broken backend operation observed honestly).",
			'export default {',
			'  async read() { return null; },',
			'  normalize() { return { entityId: null, fields: {} }; },',
			"  deletion: 'archive',",
			`  environmentFingerprint: '${fingerprint}',`,
			'};',
			'',
		].join('\n'),
	);
}

/**
 * Starts a LYING BACKEND in front of the example app (probe: HTTP 200
 * with persisted values that differ from the UI-entered input — plan
 * §3.6): POST /accounts and POST /accounts/:id form bodies get their
 * `first_name` field rewritten before the store persists them. The UI,
 * the read API, and the adapter then all observe the MUTATED value while
 * the journey typed the original — exactly the mutation-path defect the
 * exact-value echo exists to catch.
 *
 * Returns:
 *   Promise<{url, stop}>: the wrapper's loopback URL (stop kills it).
 */
export async function startMutatingExampleApp(
	field = 'first_name',
): Promise<{ url: string; stop: () => void }> {
	const { spawn } = await import('node:child_process');
	const app = await startExampleApp();
	const server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
		const isMutation = req.method === 'POST' && /^\/accounts(\/acc-[0-9]+)?$/.test(path);
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			let body = Buffer.concat(chunks);
			if (isMutation) {
				const fields = new URLSearchParams(body.toString('utf8'));
				if (fields.has(field)) {
					fields.set(field, `${fields.get(field)} (mutated)`);
					body = Buffer.from(fields.toString(), 'utf8');
				}
			}
			const forward = httpRequest(
				`${app.url}${req.url ?? '/'}`,
				{
					method: req.method,
					headers: { ...req.headers, host: new URL(app.url).host, 'content-length': String(body.length) },
				},
				(upstream) => {
					res.writeHead(upstream.statusCode ?? 502, upstream.headers);
					upstream.pipe(res);
				},
			);
			forward.on('error', () => {
				if (!res.headersSent) res.writeHead(502);
				res.end();
			});
			if (body.length > 0) forward.write(body);
			forward.end();
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('no mutating app port');
	return {
		url: `http://127.0.0.1:${address.port}`,
		stop: () => {
			server.close();
			app.stop();
		},
	};
}

export { resolve };