/**
 * WP0 acceptance, the two halves of plan §7 item 0 that only a
 * three-pack repository can prove:
 *
 * - "obligations and verdicts identical before/after": the repository a
 *   0.10 owner would have written BY HAND in 0.11 shape and the same
 *   repository after `gateforge migrate --confirm` must grade
 *   identically. The pre-0.11 engine cannot be run to produce a third
 *   opinion — its file-reading code is gone by design — so the honest
 *   comparison is against the document the owner would have written, and
 *   the test pins that the migrated sections EQUAL that document, so the
 *   two arms really are the same repository.
 * - "3 packs produce identical facts": pack-sqlalchemy, pack-http and
 *   pack-fastapi must emit byte-identical contributions whether their
 *   answer arrives as the bytes of `.gateforge/planes.json`,
 *   `.gateforge/http-clients.json` and `.gateforge/fastapi.json`, or as
 *   the `planes:` / `scan.httpClients` / `scan.fastapi` sections the
 *   migration writes. The old-file arm is fed the files' own parsed
 *   bytes — the same shape the sections have, which is the whole point of
 *   the migration — so any re-interpretation on the way in would show up
 *   here as a different fact.
 *
 * Every answer is load-bearing, or the test would pass on two empty
 * documents: without the plane rules the table stays plane-unresolved,
 * without the client-scan roots the `ui/` fetch becomes a call site, and
 * without the import roots the FastAPI mount is an unfollowable target
 * and its routes come back prefix-less.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OWNER_ANSWERS_PATH,
  loadConfig,
  withTempRepo,
  type TempRepo,
} from '@gate-forge/core';
import { parse as parseYaml } from 'yaml';
import { expandScanPaths } from '../src/glob.js';
import { gitIgnoredPaths } from '../src/git-ignored.js';
import { hostDiscoverContext, runPlugins } from '../src/plugins.js';
import { runCli } from './helpers.js';

const SQLALCHEMY_PACK = join(process.cwd(), 'packages/pack-sqlalchemy/src/index.ts');

/** The three bundled packs, in the order `runPlugins` returns them. */
const PLUGINS_YML = `  - id: gateforge.pack-sqlalchemy
    version: '0.2.0'
    transport: in-process
    module: ${SQLALCHEMY_PACK}
  - id: gateforge.pack-http
    version: '0.1.0'
    transport: in-process
    module: '@gate-forge/pack-http'
  - id: gateforge.pack-fastapi
    version: '0.1.0'
    transport: in-process
    module: '@gate-forge/pack-fastapi'
`;

const SCAN_ROOTS = "['**/*.py', '**/*.js']";

/** The policies both arms declare, so the obligation set is comparable. */
const POLICIES_YML = `\
schemaVersion: 1
policies:
  - id: user-facing-crud
    when:
      exposure: user-facing
    require:
      - persistence:read
`;

/** One SQLAlchemy table: the resource the `planes:` answer maps. */
const ACCOUNTS_MODEL = `from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class Account(Base):
    __tablename__ = 'accounts'
    __gateforge_delete_semantics__ = 'hard'
    id = Column(Integer, primary_key=True)
    name = Column(String(64))
`;

/** One Express route: the server route the client-scan answer scopes. */
const WEB_SERVER = `import express from 'express';

const app = express();

app.get('/api/accounts', (_req, res) => res.json([]));

export default app;
`;

/**
 * A frontend call site OUTSIDE the declared `clientScanRoots`: declaring
 * the roots is exactly what keeps this from being scanned as one.
 */
const UI_CLIENT = `export async function loadAccounts() {
  const response = await fetch('/api/accounts');
  return response.json();
}
`;

/** The FastAPI mount: three modules joined only by an absolute import. */
const FASTAPI_MAIN = `from fastapi import FastAPI

from app.api.main import api_router

app = FastAPI()
app.include_router(api_router, prefix="/api/v1")
`;

const FASTAPI_API_MAIN = `from fastapi import APIRouter

from app.api.routes.accounts import router

api_router = APIRouter()
api_router.include_router(router)
`;

const FASTAPI_ROUTE = `from fastapi import APIRouter

router = APIRouter()


@router.get("/accounts")
def list_accounts():
    return []
`;

/** Every source of the fixture, identical in both arms. */
const SOURCES: Record<string, string> = {
  'models/accounts.py': ACCOUNTS_MODEL,
  'web/server.js': WEB_SERVER,
  'ui/app.js': UI_CLIENT,
  'app/__init__.py': '',
  'app/main.py': FASTAPI_MAIN,
  'app/api/__init__.py': '',
  'app/api/main.py': FASTAPI_API_MAIN,
  'app/api/routes/__init__.py': '',
  'app/api/routes/accounts.py': FASTAPI_ROUTE,
};

/** The plane answer: this table's records are one customer's data. */
const PLANE_RULES = [
  { tables: ['accounts'], plane: 'tenant', reason: 'Owner-reviewed tenant data.' },
  {
    match: 'app/api/routes/accounts.py',
    plane: 'tenant',
    reason: 'The route serves tenant-owned account records.',
  },
  {
    match: 'web/server.js',
    plane: 'tenant',
    reason: 'The server exposes tenant-owned account records.',
  },
];

/** The HTTP client-scan answer: only `web/` is scanned, on both sides. */
const CLIENT_SCAN = { clientScanRoots: ['web'], serverScanRoots: ['web'] };

/** The FastAPI answer: `app` is the directory the absolute imports sit in. */
const IMPORT_ROOTS = { importRoots: ['app'] };

/**
 * `.gateforge.yml` as a 0.10.x repository left it: identical to the 0.11
 * document below MINUS the `scan:` block, which no pre-0.11 file had.
 */
function preMigrationConfigYml(): string {
  return `\
schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ${SCAN_ROOTS}
    exclude: []
plugins:
${PLUGINS_YML}policies: .gateforge/policies.yml
classificationPolicy: ${OWNER_ANSWERS_PATH}
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: fixed
  fixedAt: '2026-01-01T00:00:00.000Z'
`;
}

/** The same repository in 0.11 shape, written the way an owner would. */
const MIGRATED_CONFIG_YML = `\
schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ${SCAN_ROOTS}
    exclude: []
plugins:
${PLUGINS_YML}policies: .gateforge/policies.yml
classificationPolicy: ${OWNER_ANSWERS_PATH}
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
scan:
  scanRoots: ${SCAN_ROOTS}
  httpClients:
    clientScanRoots: ['web']
    serverScanRoots: ['web']
  fastapi:
    importRoots: ['app']
  declarations: {}
  volatileFields: []
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: fixed
  fixedAt: '2026-01-01T00:00:00.000Z'
`;

/** The pre-0.11 answers document: the scanner keys sit at its top level. */
const PRE_MIGRATION_ANSWERS = `\
# Owner answers. The reasons below ARE the review record.
schemaVersion: 1
scanRoots: ${SCAN_ROOTS}
declarations: {}
volatileFields: []
trustedInternalEntryPoints: []
internalRules: []
`;

/** The same answers, with the scanner keys gone and the sections in place. */
const MIGRATED_ANSWERS = `\
# Owner answers. The reasons below ARE the review record.
schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
planes:
  rules:
    - tables:
        - accounts
      plane: tenant
      reason: Owner-reviewed tenant data.
    - match: app/api/routes/accounts.py
      plane: tenant
      reason: The route serves tenant-owned account records.
    - match: web/server.js
      plane: tenant
      reason: The server exposes tenant-owned account records.
`;

const PRE_MIGRATION_PLANES = `${JSON.stringify({ rules: PLANE_RULES }, null, 2)}\n`;
const PRE_MIGRATION_CLIENTS = `${JSON.stringify(CLIENT_SCAN, null, 2)}\n`;
const PRE_MIGRATION_FASTAPI = `${JSON.stringify(IMPORT_ROOTS, null, 2)}\n`;

/** The shared non-owner files of both arms. */
function sharedFiles(): Record<string, string> {
  return {
    '.gitignore': '.gateforge/test-gates/\n',
    '.gateforge/policies.yml': POLICIES_YML,
    // The evidence adapter and the delete semantics the classifier needs
    // before it will grade anything; without them both arms block
    // definitionally and the comparison would be between two empty runs.
    '.gateforge/adapters/tenant.accounts.mjs': 'export default {};\n',
    ...SOURCES,
  };
}

/**
 * The repository exactly as 0.10.x left it: the old files, the scanner
 * keys at the top of the answers document, and no `scan:`.
 *
 * @param repo the temp repository under test
 */
function preMigrationRepo(repo: TempRepo): void {
  repo.writeFiles({
    ...sharedFiles(),
    '.gateforge.yml': preMigrationConfigYml(),
    [OWNER_ANSWERS_PATH]: PRE_MIGRATION_ANSWERS,
    '.gateforge/planes.json': PRE_MIGRATION_PLANES,
    '.gateforge/http-clients.json': PRE_MIGRATION_CLIENTS,
    '.gateforge/fastapi.json': PRE_MIGRATION_FASTAPI,
  });
}

/**
 * The same repository with every answer already where 0.11 keeps it —
 * the arm the migrated repository is compared against.
 *
 * @param repo the temp repository under test
 */
function migratedRepo(repo: TempRepo): void {
  repo.writeFiles({
    ...sharedFiles(),
    '.gateforge.yml': MIGRATED_CONFIG_YML,
    [OWNER_ANSWERS_PATH]: MIGRATED_ANSWERS,
  });
}

/** The `check --format json` fields that answer "what did the run conclude". */
function gradedOf(stdout: string): Record<string, unknown> {
  const report = JSON.parse(stdout) as Record<string, unknown>;
  return {
    summary: report['summary'],
    blocking: report['blocking'],
    verdicts: report['verdicts'],
    scope: report['scope'],
  };
}

/**
 * Runs every configured pack over the repository's scan paths with the
 * handed sections, through the REAL host, and returns one normalized
 * contribution per pack (config order).
 *
 * @param cwd the repository root
 * @param sections the owner sections handed to the detectors
 * @returns one JSON-normalized contribution per configured pack
 */
async function packFactsOf(
  cwd: string,
  sections: { planes?: unknown; httpClients?: unknown; fastapi?: unknown },
): Promise<readonly unknown[]> {
  const config = loadConfig(join(cwd, '.gateforge.yml'));
  const paths = expandScanPaths(
    config.project.paths.include,
    config.project.paths.exclude,
    cwd,
    gitIgnoredPaths(cwd),
  );
  const previousCwd = process.cwd();
  if (previousCwd !== cwd) process.chdir(cwd);
  try {
    const { contributions } = await runPlugins(
      config.plugins,
      paths,
      hostDiscoverContext(cwd, sections),
    );
    // Two temp repositories are two absolute prefixes; only the facts may
    // be compared, so every occurrence of the root is normalized away.
    return contributions.map((contribution) =>
      JSON.parse(JSON.stringify(contribution).split(cwd).join('<root>')),
    );
  } finally {
    if (previousCwd !== cwd) process.chdir(previousCwd);
  }
}

describe('WP0 acceptance: migrate --confirm changes no obligation, no verdict and no pack fact', () => {
  it('grades exactly as the hand-written 0.11 repository grades', async () => {
    await withTempRepo({}, async (handWritten) => {
      await withTempRepo({}, async (migrated) => {
        migratedRepo(handWritten);
        preMigrationRepo(migrated);

        expect((await runCli(migrated, ['migrate', '--confirm'])).code).toBe(0);

        // The two arms really are the same repository: the migration wrote
        // exactly the sections and scanner settings the hand-written one
        // declares. Without this the comparison below could pass on two
        // DIFFERENT repositories that happen to agree.
        const migratedConfig = loadConfig(join(migrated.root, '.gateforge.yml'));
        const handWrittenConfig = loadConfig(join(handWritten.root, '.gateforge.yml'));
        expect(migratedConfig.scan).toEqual(handWrittenConfig.scan);
        expect(
          parseYaml(readFileSync(join(migrated.root, ...OWNER_ANSWERS_PATH.split('/')), 'utf8'))
            .planes,
        ).toEqual(parseYaml(readFileSync(join(handWritten.root, ...OWNER_ANSWERS_PATH.split('/')), 'utf8')).planes);

        const before = await runCli(handWritten, ['check', '--format', 'json']);
        const after = await runCli(migrated, ['check', '--format', 'json']);
        expect(after.code, after.stderr).toBe(before.code);

        // Not vacuously equal: the run graded real obligations.
        const graded = gradedOf(after.stdout);
        const summary = graded.summary as { obligations: number };
        expect(summary.obligations).toBeGreaterThan(0);
        expect((graded.verdicts as readonly unknown[]).length).toBe(summary.obligations);
        expect(gradedOf(before.stdout)).toEqual(graded);
      });
    });
  }, 300_000);

  it('gives all three packs identical facts from the old files and from the new sections', async () => {
    await withTempRepo({}, async (repo) => {
      preMigrationRepo(repo);

      // The old answers, captured before the migration deletes them. This
      // arm is fed the files' OWN parsed bytes — the same shape the
      // sections have, which is precisely what the migration claims.
      const fromOldFiles = {
        planes: JSON.parse(PRE_MIGRATION_PLANES) as unknown,
        httpClients: JSON.parse(PRE_MIGRATION_CLIENTS) as unknown,
        fastapi: JSON.parse(PRE_MIGRATION_FASTAPI) as unknown,
      };

      expect((await runCli(repo, ['migrate', '--confirm'])).code).toBe(0);

      // The new answers, read the way the host reads them: the scanner
      // sections through the strict config loader, the answers section
      // through the document's own YAML.
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      const answers = parseYaml(
        readFileSync(join(repo.root, ...OWNER_ANSWERS_PATH.split('/')), 'utf8'),
      ) as { planes?: unknown };
      const fromSections = {
        planes: answers.planes,
        httpClients: config.scan.httpClients,
        fastapi: config.scan.fastapi,
      };

      const before = await packFactsOf(repo.root, fromOldFiles);
      const after = await packFactsOf(repo.root, fromSections);

      // Three packs, three contributions, in config order.
      expect(before).toHaveLength(3);
      expect(after).toHaveLength(3);
      expect(after).toEqual(before);
    });
  }, 300_000);

  it('the three answers are load-bearing: no section means different facts', async () => {
    await withTempRepo({}, async (repo) => {
      migratedRepo(repo);

      const declared = await packFactsOf(repo.root, {
        planes: { rules: PLANE_RULES },
        httpClients: CLIENT_SCAN,
        fastapi: IMPORT_ROOTS,
      });
      const undeclared = await packFactsOf(repo.root, {});

      // If any of the three answers were inert, this fixture would be
      // comparing two identical documents and proving nothing.
      expect(undeclared).not.toEqual(declared);
    });
  }, 300_000);
});
