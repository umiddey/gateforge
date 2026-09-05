/**
 * Real-Playwright e2e against the example/ app (playwright-evidence +
 * example-e2e classes per TESTING_POLICY.md).
 *
 * Every scenario drives the FULL stack: temp fixture project →
 * `gateforge test-gates` (real CLI) → real chromium via Playwright
 * 1.58.2 (pinned) → the example app through the loopback attestation
 * proxy → the engine-side witness → post-suite verdict evaluation.
 * No mocks anywhere in the evidence path.
 *
 * Scenarios:
 *  - honest lifecycle (create→read→update→archive): all four
 *    obligations SATISFIED, CLI exit 0 (green gate; red-probe inverse
 *    proven by the cheat scenarios).
 *  - GF-03: unrelated UI + API read under a crud:update claim → never
 *    satisfied (missing), red run.
 *  - GF-04: a create flow borrowed by a crud:update claim → operation
 *    mismatch, invalid, red run.
 *  - GF-05: adapter returns genuine evidence for a DIFFERENT entity →
 *    same-entity violation, invalid, red run.
 *  - GF-22: forged receipt feeding persistence.verify → rejected, no
 *    records, claim missing, red run.
 *  - GF-23: fabricated records.json without service-issued recordIds →
 *    gate re-evaluation grades invalid/missing (never satisfied).
 *  - GF-24: bypass-import spec (raw playwright/test) → no claims →
 *    obligation missing; orphan records flagged, red run.
 *  - standalone exit-code semantics: a claim that is unsatisfied while
 *    the test itself passes fails the run under
 *    GATEFORGE_REPORTER_FAIL_RUN=1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fingerprint } from '@gateforge/core';
import {
	CLI_BIN,
	FINGERPRINT,
	PACK_REPORTER,
	PLAYWRIGHT_CLI,
	buildPack,
	makeTempProject,
	readJson,
	removeTempProject,
	run,
	startExampleApp,
	writeFixtureProject,
	writeHonestAdapter,
	writeWrongEntityAdapter,
} from './helpers.js';
import { startAttestationProxy } from '../src/attestation/proxy.js';
import { startWitness } from '../src/witness/server.js';

const LIFECYCLE = {
	create: true,
	read: true,
	update: true,
	delete: true,
	deleteSemantics: 'archive' as const,
	// Owner-declared archived state (audit round 5): graded by the engine
	// against the witness's own observation, never suite expectations.
	archiveFields: { status: 'archived' },
	// Owner-declared update relevance (audit round 6).
	updateableFields: ['first_name', 'last_name', 'status'],
};
const CLAIMS = {
	create: 'tenant.accounts:persistence:create',
	read: 'tenant.accounts:persistence:read',
	update: 'tenant.accounts:persistence:update',
	delete: 'tenant.accounts:persistence:delete',
};

/** Cleanup safety net (each scenario also disposes itself). */
const CLEANUPS: Array<() => Promise<void> | void> = [];

beforeAll(() => {
	const build = buildPack();
	expect(build.status, `pack build failed:\n${build.stderr}`).toBe(0);
});

afterAll(async () => {
	for (const cleanup of CLEANUPS.splice(0)) {
		await cleanup();
	}
});

/** One full scenario scaffold: project, app, proxy, witness, config. */
async function scaffoldSuite(
	spec: string,
	options: { adapter?: 'honest' | 'wrong-entity' } = {},
) {
	const project = makeTempProject('e2e');
	writeFixtureProject(project);
	if (options.adapter === 'wrong-entity') writeWrongEntityAdapter(project);
	else writeHonestAdapter(project);
	mkdirSync(join(project, '.gateforge/test-gates'), { recursive: true });

	const app = await startExampleApp();
	const proxy = await startAttestationProxy(app.url, FINGERPRINT);
	const stateDir = join(project, '.gateforge/test-gates');
	const token = randomUUID();
	const runId = randomUUID();
	// Attestation secret (GF-23): distinct from the run token. The run
	// token reaches the SUITE env (it authorizes evidence submission);
	// the verifier key stays with this scaffold and the CLI only.
	const verifierKey = randomUUID();
	const witness = await startWitness({
		runId,
		token,
		verifierKey,
		stateDir,
		adaptersDir: join(project, '.gateforge/adapters'),
		classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
		targetBaseUrl: proxy.url,
		targetFingerprint: FINGERPRINT,
		adapterBaseUrl: proxy.url,
	});

	// Suite-visible obligations document (the CLI writes the same file
	// during its own runs; scaffolds without the CLI need it for the
	// reporter's per-claim ledger, e.g. the standalone scenario).
	const obligations = [
		{ id: CLAIMS.create, contract: 'persistence:create' },
		{ id: CLAIMS.read, contract: 'persistence:read' },
		{ id: CLAIMS.update, contract: 'persistence:update' },
		{ id: CLAIMS.delete, contract: 'persistence:delete' },
	].map((entry) => {
		const [resourceId] = entry.id.split(':');
		return {
			id: entry.id,
			resourceId: resourceId as string,
			contract: entry.contract,
			policyId: 'crud',
			lifecycle: LIFECYCLE,
			fingerprint: fingerprint({
				resourceId: resourceId as string,
				contract: entry.contract,
				policyId: 'crud',
				lifecycle: LIFECYCLE,
			}),
			source: 'src/accounts.js',
			location: { file: 'src/accounts.js', line: 1, col: 0 },
		};
	});
	writeFileSync(
		join(stateDir, 'obligations.json'),
		`${JSON.stringify({ schemaVersion: 1, obligations })}\n`,
	);

	const configPath = join(project, 'playwright.config.mjs');
	writeFileSync(
		configPath,
		[
			"import { defineConfig } from 'playwright/test';",
			'export default defineConfig({',
			"  testDir: 'specs',",
			'  fullyParallel: false,',
			'  workers: 1,',
			'  retries: 0,',
			'  forbidOnly: true,',
			`  reporter: [['list'], ['${PACK_REPORTER}', {}]],`,
			'  use: { headless: true, trace: "off" },',
			'  timeout: 60_000,',
			'});',
			'',
		].join('\n'),
	);
	writeFileSync(join(project, 'specs/run.spec.js'), spec);

	const suiteCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(PLAYWRIGHT_CLI)} test --config ${JSON.stringify(configPath)}`;
	const dispose = async () => {
		await witness.stop();
		await proxy.stop();
		app.stop();
	};
	return { project, stateDir, proxyUrl: proxy.url, suiteCommand, witnessUrl: witness.url, token, verifierKey, runId, dispose };
}

/**
 * Runs `gateforge test-gates` for a scenario; returns outcome + report.
 *
 * MUST spawn asynchronously: the in-process witness server lives on THIS
 * worker's event loop, and a sync spawn would block the loop and deadlock
 * every fixture call the suite makes.
 */
async function runTestGates(
	scaffold: Awaited<ReturnType<typeof scaffoldSuite>>,
	suiteCommand: string,
	env: NodeJS.ProcessEnv = {},
): Promise<{
	result: { status: number | null; stdout: string; stderr: string };
	report: {
		summary?: { obligations: number; blocking: number };
		verdicts?: Array<{ obligationId: string; verdict: string; reason: string | null }>;
	} | null;
}> {
	const { project, stateDir, witnessUrl, token, verifierKey } = scaffold;
	const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
		(resolve) => {
			const child = spawn(
				process.execPath,
				[
					CLI_BIN,
					'test-gates',
					'--out', stateDir,
					'--suite', suiteCommand,
					'--witness-url', witnessUrl,
					'--run-token', token,
				],
				{
					cwd: project,
					// Attestation channel (GF-23): the verifier key travels by
					// ENVIRONMENT — never argv, whose /proc cmdline is
					// world-readable. Orchestrator-side only; the suite child
					// gets its env from the CLI, which strips this var.
					env: {
						GATEFORGE_APP_BASE_URL: '',
						GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey,
						...env,
					},
				},
			);
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on('data', (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const killer = setTimeout(() => child.kill('SIGKILL'), 180_000);
			child.on('exit', (status: number | null) => {
				clearTimeout(killer);
				resolve({ status, stdout, stderr });
			});
		},
	);
	const report = readJson(join(stateDir, 'report.json')) as {
		summary?: { obligations: number; blocking: number };
		verdicts?: Array<{ obligationId: string; verdict: string; reason: string | null }>;
	} | null;
	return { result, report };
}

/** Verdict lookup by obligation id from the CLI report. */
function verdictOf(
	report: { verdicts?: Array<{ obligationId: string; verdict: string }> } | null,
	obligationId: string,
): string | undefined {
	return report?.verdicts?.find((entry) => entry.obligationId === obligationId)?.verdict;
}

const HONEST_LIFECYCLE_SPEC = `
import { test, expect } from '@gateforge/pack-playwright';

let createdId = '';

test('creates an account through the rendered UI', {
  annotation: { type: 'gateforge', description: '${CLAIMS.create}' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.create({ fields: { first_name: 'Ada', last_name: 'Lovelace' } });
  createdId = receipt.entityId;
  await evidence.visible.confirm(receipt);
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  const summary = await evidence.finalize();
  expect(summary.records.length).toBeGreaterThan(0);
});

test('reads the account through the rendered UI', {
  annotation: { type: 'gateforge', description: '${CLAIMS.read}' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.read({ entityId: createdId });
  await evidence.visible.confirm(receipt);
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});

test('updates the account through the rendered UI', {
  annotation: { type: 'gateforge', description: '${CLAIMS.update}' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.update({ entityId: createdId, fields: { first_name: 'Ada King', last_name: 'Lovelace' } });
  await evidence.visible.confirm(receipt);
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});

test('archives the account through the rendered UI', {
  annotation: { type: 'gateforge', description: '${CLAIMS.delete}' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.archive({ entityId: createdId });
  await evidence.visible.confirm(receipt);
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});
`;

describe('honest end-to-end (real Playwright vs the example app)', () => {
	it('satisfies create/read/update/delete with witnessed records; CLI exit 0', async () => {
		const scaffold = await scaffoldSuite(HONEST_LIFECYCLE_SPEC);
		try {
			const { result, report } = await runTestGates(
				scaffold,
				scaffold.suiteCommand,
				{ GATEFORGE_APP_BASE_URL: scaffold.proxyUrl },
			);
			expect(result.status, `CLI stderr:\n${result.stderr}\nCLI stdout:\n${result.stdout}`).toBe(0);
			expect(report?.summary?.obligations).toBe(4);
			expect(report?.summary?.blocking).toBe(0);
			expect(verdictOf(report, CLAIMS.create)).toBe('satisfied');
			expect(verdictOf(report, CLAIMS.read)).toBe('satisfied');
			expect(verdictOf(report, CLAIMS.update)).toBe('satisfied');
			expect(verdictOf(report, CLAIMS.delete)).toBe('satisfied');
			const records = readJson(join(scaffold.stateDir, 'records.json')) as Array<{
				recordId: string;
				trust: string;
				origin: string;
				kind: string;
			}>;
			expect(records.length).toBeGreaterThanOrEqual(12); // 4 actions + 4 visible + 4 persistence
			// Trust follows origin (GF-23 round 3): suite-submitted UI
			// assertions are claimed; only engine-observed persistence reads
			// are witnessed — and the claims still satisfy on that basis.
			expect(
				records.every((record) =>
					record.kind === 'persistence.entity'
						? record.trust === 'witnessed' && record.origin === 'engine-observed'
						: record.trust === 'claimed' && record.origin === 'suite-submitted',
				),
			).toBe(true);
			expect(records.every((record) => /^[0-9a-f]{64}$/.test(record.recordId))).toBe(true);
		} finally {
			await scaffold.dispose();
			removeTempProject(scaffold.project);
		}
	});
});

describe('adversarial fixtures (each red run grades its claim blocking)', () => {
	it('GF-03: unrelated UI action + API read under a crud:update claim → never satisfied', async () => {
		const spec = `
import { test, expect } from '@gateforge/pack-playwright';

test('claims crud:update but only performs unrelated browsing and reads', {
  annotation: { type: 'gateforge', description: '${CLAIMS.update}' },
}, async ({ page, evidence, request }) => {
  const base = process.env.GATEFORGE_APP_BASE_URL;
  await page.goto(base + '/');
  await page.click('nav a[href="/accounts/new"]');            // unrelated navigation
  await page.goto(base + '/');
  const api = (await (await request.get(base + '/api/accounts')).json()); // unrelated API read
  expect(Array.isArray(api.accounts)).toBe(true);
  await evidence.finalize();                                   // throws: zero records
});
`;
		const scaffold = await scaffoldSuite(spec);
		try {
			const { result, report } = await runTestGates(
				scaffold,
				scaffold.suiteCommand,
				{ GATEFORGE_APP_BASE_URL: scaffold.proxyUrl },
			);
			expect(result.status).toBe(1); // test failed (finalize fail-fast) + blocking verdict
			expect(['missing', 'invalid']).toContain(verdictOf(report, CLAIMS.update));
			const records = readJson(join(scaffold.stateDir, 'records.json')) as unknown[];
			expect(records).toHaveLength(0);
		} finally {
			await scaffold.dispose();
			removeTempProject(scaffold.project);
		}
	});

	it('GF-04: create-flow evidence borrowed by a crud:update claim → invalid (operation mismatch)', async () => {
		const spec = `
import { test, expect } from '@gateforge/pack-playwright';

test('honest create claims crud:create', {
  annotation: { type: 'gateforge', description: '${CLAIMS.create}' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.create({ fields: { first_name: 'Grace', last_name: 'Hopper' } });
  await evidence.visible.confirm(receipt);
  await evidence.persistence.verify(receipt);
  await evidence.finalize();
});

test('borrows the create operation under a crud:update claim', {
  annotation: { type: 'gateforge', description: '${CLAIMS.update}' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.create({ fields: { first_name: 'Grace', last_name: 'Hopper' } });
  await evidence.visible.confirm(receipt);
  await evidence.persistence.verify(receipt);
  await evidence.finalize();
});
`;
		const scaffold = await scaffoldSuite(spec);
		try {
			const { result, report } = await runTestGates(
				scaffold,
				scaffold.suiteCommand,
				{ GATEFORGE_APP_BASE_URL: scaffold.proxyUrl },
			);
			expect(verdictOf(report, CLAIMS.create)).toBe('satisfied');
			expect(verdictOf(report, CLAIMS.update)).toBe('invalid');
			const updateEntry = report?.verdicts?.find((entry) => entry.obligationId === CLAIMS.update);
			expect(updateEntry?.reason ?? '').toMatch(/has operation|requires 'update'/i);
			expect(result.status).toBe(1); // blocking verdict (invalid)
		} finally {
			await scaffold.dispose();
			removeTempProject(scaffold.project);
		}
	});

	it('GF-05: adapter evidence for a different entity → same-entity violation, invalid', async () => {
		const spec = `
import { test, expect } from '@gateforge/pack-playwright';

test('seeds three accounts through the raw UI (no claims)', async ({ page }) => {
  const base = process.env.GATEFORGE_APP_BASE_URL;
  for (const [first, last] of [['Ada', 'Lovelace'], ['Eve', 'Miller'], ['Mallory', 'Hacker']]) {
    await page.goto(base + '/accounts/new');
    await page.locator('input[name="first_name"]').fill(first);
    await page.locator('input[name="last_name"]').fill(last);
    await page.locator('button[type="submit"]').click();
  }
});

test('updates acc-1 but the adapter returns acc-3 evidence', {
  annotation: { type: 'gateforge', description: '${CLAIMS.update}' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.update({ entityId: 'acc-1', fields: { first_name: 'Ada King', last_name: 'Lovelace' } });
  await evidence.visible.confirm(receipt);
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true); // RED: adapter says acc-3
  await evidence.finalize();
});
`;
		const scaffold = await scaffoldSuite(spec, { adapter: 'wrong-entity' });
		try {
			const { result, report } = await runTestGates(
				scaffold,
				scaffold.suiteCommand,
				{ GATEFORGE_APP_BASE_URL: scaffold.proxyUrl },
			);
			expect(result.status).toBe(1); // test failure (fieldsMatch false) + blocking verdict
			expect(verdictOf(report, CLAIMS.update)).toBe('invalid');
			const updateEntry = report?.verdicts?.find((entry) => entry.obligationId === CLAIMS.update);
			expect(updateEntry?.reason ?? '').toMatch(/same-entity violation/);
		} finally {
			await scaffold.dispose();
			removeTempProject(scaffold.project);
		}
	});

	it('GF-22: forged receipt feeding a trusted primitive → rejected, claim missing', async () => {
		const spec = `
import { test } from '@gateforge/pack-playwright';

test('feeds a hand-rolled receipt to persistence.verify', {
  annotation: { type: 'gateforge', description: '${CLAIMS.update}' },
}, async ({ evidence }) => {
  const forged = { kind: 'ui', operation: 'update', resourceId: 'tenant.accounts', entityId: 'acc-1', fields: {}, mode: 'row' };
  await evidence.persistence.verify(forged); // throws: not a genuine receipt
});
`;
		const scaffold = await scaffoldSuite(spec);
		try {
			const { result, report } = await runTestGates(
				scaffold,
				scaffold.suiteCommand,
				{ GATEFORGE_APP_BASE_URL: scaffold.proxyUrl },
			);
			expect(result.status).toBe(1); // test failed (receipt rejected)
			expect(['missing', 'invalid']).toContain(verdictOf(report, CLAIMS.update));
		} finally {
			await scaffold.dispose();
			removeTempProject(scaffold.project);
		}
	});

	it('GF-23: fabricated records.json without service-issued recordIds → gate grades invalid, never satisfied', async () => {
		const scaffold = await scaffoldSuite(HONEST_LIFECYCLE_SPEC);
		try {
			const honest = await runTestGates(
				scaffold,
				scaffold.suiteCommand,
				{ GATEFORGE_APP_BASE_URL: scaffold.proxyUrl },
			);
			expect(honest.result.status, `honest baseline should be green:\n${honest.result.stderr}`).toBe(0);
			expect(verdictOf(honest.report, CLAIMS.update)).toBe('satisfied');

			// Adversarial replay: REPLACE the reporter's records.json with a
			// fabricated, internally consistent bundle whose recordIds were
			// never issued by the witness (service provenance removed).
			const fabricated = [
				{
					schemaVersion: 1,
					recordId: 'not-a-service-issued-record-id',
					runId: '00000000-0000-0000-0000-000000000000',
					trust: 'witnessed',
					obligationId: CLAIMS.update,
					kind: 'ui.action',
					testId: 'fake-test',
					payload: {
						operation: 'update',
						entityId: 'acc-1',
						fields: { first_name: 'Mallory', last_name: 'Hacker' },
					},
				},
				{
					schemaVersion: 1,
					trust: 'witnessed',
					obligationId: CLAIMS.update,
					kind: 'persistence.entity',
					testId: 'fake-test',
					payload: {
						resourceId: 'tenant.accounts',
						entityId: 'acc-1',
						fields: { first_name: 'Mallory', last_name: 'Hacker', status: 'active' },
					},
				},
			];
			writeFileSync(join(scaffold.stateDir, 'records.json'), `${JSON.stringify(fabricated)}\n`);
			writeFileSync(
				join(scaffold.stateDir, 'claims.json'),
				`${JSON.stringify([
					{
						schemaVersion: 1,
						obligationId: CLAIMS.update,
						testId: 'fake-test',
						testFile: 'fake.spec.js',
					},
				])}\n`,
			);

			const check = run(process.execPath, [CLI_BIN, 'check', '--format', 'json'], {
				cwd: scaffold.project,
				timeoutMs: 120_000,
			});
			expect(check.status, `check stdout:\n${check.stdout}\ncheck stderr:\n${check.stderr}`).toBe(1); // blocking: fake records are claimed-tier
			// `check` prints its report; report.json is test-gates' artifact
			// (and would still hold the honest run's satisfied verdicts).
			const report = JSON.parse(check.stdout) as {
				verdicts?: Array<{ obligationId: string; verdict: string }>;
			} | null;
			expect(verdictOf(report, CLAIMS.update)).toBe('invalid');
		} finally {
			await scaffold.dispose();
			removeTempProject(scaffold.project);
		}
	});

	it('GF-24: bypassing the fixture (raw playwright/test) → no claims, obligation missing, orphans flagged', async () => {
		const spec = `
import { test, expect } from 'playwright/test';

test('performs obligation-relevant flows without any gateforge claim', async ({ page }) => {
  const base = process.env.GATEFORGE_APP_BASE_URL;
  await page.goto(base + '/accounts/new');
  await page.locator('input[name="first_name"]').fill('Mallory');
  await page.locator('input[name="last_name"]').fill('Hacker');
  await page.locator('button[type="submit"]').click();
  // Directly posts a record through the witness env (bypass attempt).
  await fetch(process.env.GATEFORGE_WITNESS_URL + '/records', {
    method: 'POST',
    headers: { 'x-gateforge-run': process.env.GATEFORGE_RUN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({
      claimId: '${CLAIMS.update}',
      kind: 'ui.action',
      payload: { operation: 'update', entityId: 'acc-1', fields: {} },
      testId: 'bypass-test',
    }),
  });
  expect(true).toBe(true);
});
`;
		const scaffold = await scaffoldSuite(spec);
		try {
			const { result, report } = await runTestGates(
				scaffold,
				scaffold.suiteCommand,
				{ GATEFORGE_APP_BASE_URL: scaffold.proxyUrl },
			);
			// The bypass test itself is green; the GATE still grades the
			// obligation missing (claim registry vs records mismatch, GF-24).
			expect(result.status).toBe(1);
			expect(verdictOf(report, CLAIMS.update)).toBe('missing');
			const claims = readJson(join(scaffold.stateDir, 'claims.json'));
			expect(claims === null || (Array.isArray(claims) && claims.length === 0)).toBe(true);
			expect(result.stderr).toMatch(/obligations without any claim/);
			expect(result.stderr).toContain('bypass-test');
		} finally {
			await scaffold.dispose();
			removeTempProject(scaffold.project);
		}
	});
});

describe('standalone reporter exit-code semantics', () => {
	it('an unsatisfied claim with a passing test fails the run under GATEFORGE_REPORTER_FAIL_RUN=1', async () => {
		const spec = `
import { test } from '@gateforge/pack-playwright';

test('claims an obligation but never collects evidence', {
  annotation: { type: 'gateforge', description: '${CLAIMS.update}' },
}, async () => {
  // The test itself passes; only the reporter's gate ledger is blocking.
});
`;
		const scaffold = await scaffoldSuite(spec);
		try {
			// Async spawn: the in-process witness lives on this worker's
			// event loop — a sync spawn would deadlock every fixture call.
			const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
				(resolve) => {
					const child = spawn(
						process.execPath,
						[PLAYWRIGHT_CLI, 'test', '--config', join(scaffold.project, 'playwright.config.mjs')],
						{
							cwd: scaffold.project,
							env: {
								GATEFORGE_WITNESS_URL: scaffold.witnessUrl,
								GATEFORGE_RUN_TOKEN: scaffold.token,
								GATEFORGE_STATE_DIR: scaffold.stateDir,
								GATEFORGE_OBLIGATIONS: join(scaffold.stateDir, 'obligations.json'),
								GATEFORGE_APP_BASE_URL: scaffold.proxyUrl,
								GATEFORGE_REPORTER_FAIL_RUN: '1',
							},
						},
					);
					let stdout = '';
					let stderr = '';
					child.stdout.on('data', (chunk: Buffer) => {
						stdout += chunk.toString();
					});
					child.stderr.on('data', (chunk: Buffer) => {
						stderr += chunk.toString();
					});
					const killer = setTimeout(() => child.kill('SIGKILL'), 120_000);
					child.on('exit', (status: number | null) => {
						clearTimeout(killer);
						resolve({ status, stdout, stderr });
					});
				},
			);
			// Honest documentation of the observed semantics: the reporter's
			// process.exitCode survives Playwright's own guard in 1.58.2,
			// so a passed test with an unsatisfied claim fails the run.
			expect(result.status).toBe(1);
			expect(result.stdout).toMatch(/GATEFORGE GATE: FAIL/);
		} finally {
			await scaffold.dispose();
			removeTempProject(scaffold.project);
		}
	});
});

describe('packaging: the reporter resolves from CJS contexts', () => {
	it('require.resolve + require() drive the real witness path (CJS playwright configs)', async () => {
		// The phase-7 dogfood blocker: `exports['./reporter']` carried only
		// an `import` condition, so Playwright's CJS-config
		// `require.resolve('@gateforge/pack-playwright/reporter')` died
		// with ERR_PACKAGE_PATH_NOT_EXPORTED. Prove the documented usage
		// end-to-end from a REAL downstream-shaped project: a CJS driver
		// resolves the `require` condition, loads the class, and drives a
		// live witness (the shim lazily imports the ESM implementation).
		const project = makeTempProject('cjs-reporter');
		writeFixtureProject(project);
		writeHonestAdapter(project);
		const stateDir = join(project, '.gateforge/test-gates');
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, 'obligations.json'),
			JSON.stringify({
				schemaVersion: 1,
				obligations: [
					{
						id: CLAIMS.update,
						resourceId: 'tenant.accounts',
						contract: 'persistence:update',
						policyId: 'crud',
						lifecycle: LIFECYCLE,
						fingerprint: 'f-update',
						source: 'src/accounts.js',
						location: { file: 'src/accounts.js', line: 1, col: 0 },
					},
				],
			}),
		);
		writeFileSync(
			join(project, 'cjs-reporter-driver.cjs'),
			[
				"'use strict';",
				"const assert = require('node:assert');",
				// The exact call a CJS playwright.config.js forces:
				"const resolved = require.resolve('@gateforge/pack-playwright/reporter');",
				"assert(resolved.endsWith('reporter.cjs'), 'unexpected resolution: ' + resolved);",
				"const GateforgeReporter = require('@gateforge/pack-playwright/reporter');",
				"assert.strictEqual(typeof GateforgeReporter, 'function');",
				'const reporter = new GateforgeReporter({});',
				// Buffered until the ESM implementation loads, then replayed.
				`reporter.onTestEnd({ id: 'cjs-driver-test', annotations: [{ type: 'gateforge', description: '${CLAIMS.update}' }], location: { file: 'driver.cjs', line: 1, column: 0 } }, { status: 'passed' });`,
				'reporter.onEnd().then(() => process.stdout.write(\'CJS-REPORTER-OK\\n\'), (error) => { console.error(error); process.exit(1); });',
				'',
			].join('\n'),
		);
		const token = randomUUID();
		const witness = await startWitness({
			runId: randomUUID(),
			token,
			classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
		});
		try {
			// Async spawn: the in-process witness lives on this worker's
			// event loop — a sync spawn would deadlock every reporter call.
			const outcome = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
				(resolve) => {
					const child = spawn(process.execPath, [join(project, 'cjs-reporter-driver.cjs')], {
						cwd: project,
						env: {
							GATEFORGE_WITNESS_URL: witness.url,
							GATEFORGE_RUN_TOKEN: token,
							GATEFORGE_STATE_DIR: stateDir,
							GATEFORGE_OBLIGATIONS: join(stateDir, 'obligations.json'),
						},
					});
					let stdout = '';
					let stderr = '';
					child.stdout.on('data', (chunk: Buffer) => {
						stdout += chunk.toString();
					});
					child.stderr.on('data', (chunk: Buffer) => {
						stderr += chunk.toString();
					});
					const killer = setTimeout(() => child.kill('SIGKILL'), 120_000);
					child.on('exit', (status: number | null) => {
						clearTimeout(killer);
						resolve({ status, stdout, stderr });
					});
				},
			);
			expect(outcome.status, `driver failed:\n${outcome.stderr}`).toBe(0);
			expect(outcome.stdout).toContain('CJS-REPORTER-OK');
			// The CJS-loaded reporter actually wrote the claim registry the
			// same way the ESM entry does.
			const claims = readJson(join(stateDir, 'claims.json')) as Array<{
				obligationId: string;
				testId: string;
			}> | null;
			expect(Array.isArray(claims)).toBe(true);
			expect(claims?.[0]?.obligationId).toBe(CLAIMS.update);
			expect(claims?.[0]?.testId).toBe('cjs-driver-test');
		} finally {
			await witness.stop();
			removeTempProject(project);
		}
	});
});

void randomUUID;