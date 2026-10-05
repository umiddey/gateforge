# Gateforge example accounts app

Isolated demo application for Gateforge Phase 4 verification: an in-memory
`accounts` resource with a server-rendered HTML UI (create / edit / archive)
and a read-only JSON API (trusted-adapter surface).

- Plain Node ESM (`node:http`), **zero external dependencies**.
- Binds **127.0.0.1 only**; no network beyond loopback.
- State is in-memory; **archive is a status change, there is no hard delete**
  (plan §5.2).
- Timestamps come from an **injectable clock**: `createApp({ clock })` where
  `clock` is a function whose return value is passed to `new Date()`
  (defaults to the system clock). Timestamps are ISO-8601 strings.

## Gateforge first run

Install the CLI and the packs first — this app needs the CLI, the HTTP
detector pack (its config loads it) and the Playwright pack (the witnessed
run in `behavior/` is driven through it). Keep every direct
`@gate-forge/*` package on the SAME release; a mixed set exits 2 with
`GATEFORGE_PACKAGE_INCOMPATIBLE`.

```sh
npm i -D \
  @gate-forge/cli@0.10.2 \
  @gate-forge/pack-playwright@0.10.2 \
  @gate-forge/pack-http@0.10.2
```

**If your release is not on the registry yet** (a pre-publish set of
tarballs), install every tarball of that release in ONE command — npm
resolves the packages' own dependencies from the files themselves, so the
CLI, the shared packages and every pack end up on one consistent version:

```sh
npm i -D ./gate-forge-*.tgz
```

Then put the project-local binary on your `PATH` (`export
PATH="$PWD/node_modules/.bin:$PATH"`) or prefix the commands below with
`npx `.

Run these commands from `example/`. The checked-in `.gateforge/planes.json` and `.gateforge/endpoints.json` make the sample's route classification and endpoint behavior explicit; the verification script is excluded from product-source scanning.

```sh
gateforge init --no-ci --no-blocking
gateforge check
gateforge next
```

The scan recommends `gateforge.pack-http`. The check reports 10 endpoint routes and:

```text
gateforge run: 0 obligation(s) — 0 satisfied, 0 waived, 0 blocking
exit code: 0
```

`exit code:` is the code the process exits with. When a non-blocking mode
(`mode: warn` or `mode: changed`) softens a blocking result, the report says
`would exit 1 in blocking mode` instead — the same fact, named as what it is.

One non-blocking test-map advisory remains for the standalone UI journey; this in-memory app has no persistence adapter for that persistence claim. Navigation is:

```text
next: none — clean
```

## Where the witnessed run lives

This root project is a STATIC `check` demo: `gateforge check` classifies the routes
and reports. There is no receipt lane here, so asking for one can only say that
none exists:

```sh
$ gateforge check --require-e2e
require-e2e: no gate receipt exists for the current state — run `gateforge test-gates --changed` to execute the configured E2E suite ...
exit code: 1
```

The witnessed project is the sub-directory `behavior/` — it carries its own
`.gateforge.yml`, adapters, behavior policy, test map and Playwright config, and a
run started at the root does not see it. It declares every route the app exposes
in `.gateforge/behavior.yml` (mutating routes as `http:effect-verified` cases, read
routes as `http:read-result-verified` cases), so an undeclared route would block
with `ENDPOINT_BEHAVIOR_MISSING` instead of hiding.

One command runs the whole witnessed proof on a fresh copy:

```sh
$ cd behavior
$ npm install
$ npm run gate
```

Once per machine, before the first run: the runner's browsers are a Playwright
download, not an npm one, and an empty cache fails every test with
`browserType.launch: Executable doesn't exist`. Install them once in this
directory — `gateforge enforcement doctor` prints this exact command and this
exact directory when they are missing:

```sh
$ npx playwright install chromium
```

On a Linux machine that has no browser system libraries — a container, a CI
image, WSL — that install is not enough: the download lands, the tests still
die, and the doctor says so by name:

```sh
$ npx playwright install --with-deps chromium   # needs root or sudo
```

`gateforge enforcement doctor` reports a build in exactly this state by name,
with the loader's own line and the command that fixes it:

```text
[FAIL] runner: playwright installed; the browser build '<cache>/chromium-<revision>' is installed but
cannot start on this machine: …/chrome: error while loading shared libraries: libnss3.so: cannot open
shared object file; fix: run `npx playwright install-deps chromium` in '<this directory>' (installs the
browser's system libraries; needs root or sudo)
```

(`gateforge run` stops at that same line before the suite starts, with exit 1.)

`npm run gate` (`scripts/gate.mjs`) does what a supervised run needs around it:

1. picks a free loopback port and starts the app on it (a supervised
   `test-gates` run never loads the Playwright config, so its `webServer` never
   starts the app);
2. creates a verifier key ring in the OS temp directory, outside the repository
   (mode 0600, never printed), and removes it at the end;
3. sets `GATEFORGE_APP_BASE_URL`, `GATEFORGE_TARGET_BASE_URL`,
   `GATEFORGE_TARGET_FINGERPRINT`, `GATEFORGE_FIXTURE_PROVIDER` and
   `GATEFORGE_WITNESS_VERIFIER_KEY_FILE` for the three commands it runs:
   `gateforge tests discover`, `gateforge test-gates --changed` and
   `gateforge check --require-e2e`;
4. stops the app and exits with the `check --require-e2e` status.

A green run seals a receipt and ends with `check --require-e2e` exiting 0. To
run the same steps by hand, start `node server.js --port <port>` first and set the
five variables above yourself.

## Run

```sh
node server.js             # random free port, prints the bound URL
node server.js --port 4173 # fixed port
npm start                  # same as `node server.js`
```

Requires Node >= 20. Invalid `--port` values exit with code 2 (usage error).

## Endpoints

UI (server-rendered HTML, plain form posts; every mutation answers
`303 See Other` to `/` so the list is the visible result):

| Method | Path                      | Purpose                                              |
| ------ | ------------------------- | ---------------------------------------------------- |
| GET    | `/`                       | Accounts list; archived rows stay visible, marked     |
| GET    | `/accounts/new`           | Create form (fields: `first_name`, `last_name`)      |
| POST   | `/accounts`               | Create                                               |
| GET    | `/accounts/:id/edit`      | Edit form (prefilled) + archive control              |
| POST   | `/accounts/:id`           | Update name fields                                   |
| POST   | `/accounts/:id/archive`   | Archive (sets `status: "archived"`, keeps the row)   |

JSON read API (canonical JSON: compact, recursively key-sorted):

| Method | Path                   | Result                                             |
| ------ | ---------------------- | -------------------------------------------------- |
| GET    | `/api/accounts`        | `200` `{"accounts":[...]}`                          |
| GET    | `/api/accounts/:id`    | `200` account object; `404` `{"error":"not found"}` |

Error paths: missing/blank name fields → `422` with the form re-rendered and
an error message; unknown id (UI or API) → `404`; non-form-encoded POST body →
`415`; oversized body → `413`.

## Data model

```
{ "id": "acc-1",            // server-issued, monotonic, never reused
  "first_name": "Ada",
  "last_name": "Lovelace",
  "status": "active",       // active | archived
  "created_at": "2026-08-30T20:27:43.188Z",
  "updated_at": "2026-08-30T20:27:43.188Z" }
```

## UI flows

- **Create**: `Accounts → New account`, fill both fields, submit → redirected
  to the list where the new row appears with `status: active`.
- **Read**: the list shows id, names, status, and both timestamps for every
  account, archived included (muted row + `archived` badge).
- **Update**: `Edit` on a row → prefilled form → change names, submit → list
  shows the changed values and a fresh `updated_at` (`created_at` preserved).
- **Archive**: the `Archive` button on a list row or on the edit page →
  redirected to the list where the row is marked `archived`. Archived accounts
  remain retrievable via the API and editable, but the archive control
  disappears (already archived).

## Verified smoke record

Environment: Node `v24.11.0`, Linux x64, gateforge repo `example/`, 2026-08-30.
Server: `node server.js --port 4173` → `gateforge example app listening on http://127.0.0.1:4173`.

### Read API, empty store and unknown id

```sh
$ curl -sS -w '\n[%{http_code}]\n' http://127.0.0.1:4173/api/accounts
{"accounts":[]}
[200]
$ curl -sS -w '\n[%{http_code}]\n' http://127.0.0.1:4173/api/accounts/acc-42
{"error":"not found"}
[404]
```

### Create (form post) → visible in list and by id

```sh
$ curl -sS -w '\n[%{http_code}] location=%{redirect_url}\n' -X POST \
    http://127.0.0.1:4173/accounts --data 'first_name=Ada&last_name=Lovelace'
[303] location=http://127.0.0.1:4173/
$ curl -sS -w '\n[%{http_code}]\n' http://127.0.0.1:4173/api/accounts
{"accounts":[{"created_at":"2026-08-30T20:27:43.188Z","first_name":"Ada","id":"acc-1","last_name":"Lovelace","status":"active","updated_at":"2026-08-30T20:27:43.188Z"}]}
[200]
```

### Update (form post) → changed values visible

```sh
$ curl -sS -w '\n[%{http_code}]\n' -X POST \
    http://127.0.0.1:4173/accounts --data 'first_name=Grace&last_name=Hopper' # seeds acc-2
$ curl -sS -w '\n[%{http_code}] location=%{redirect_url}\n' -X POST \
    http://127.0.0.1:4173/accounts/acc-1 --data 'first_name=Augusta&last_name=King'
[303] location=http://127.0.0.1:4173/
$ curl -sS http://127.0.0.1:4173/api/accounts
{"accounts":[{"created_at":"2026-08-30T20:27:43.188Z","first_name":"Augusta","id":"acc-1","last_name":"King","status":"active","updated_at":"2026-08-30T20:27:52.167Z"},{"created_at":"2026-08-30T20:27:52.126Z","first_name":"Grace","id":"acc-2","last_name":"Hopper","status":"active","updated_at":"2026-08-30T20:27:52.126Z"}]}
```

`acc-1` shows the new names; `created_at` unchanged, `updated_at` advanced.

### Archive (form post) → status change, still retrievable

```sh
$ curl -sS -w '\n[%{http_code}] location=%{redirect_url}\n' -X POST \
    http://127.0.0.1:4173/accounts/acc-1/archive
[303] location=http://127.0.0.1:4173/
$ curl -sS -w '\n[%{http_code}]\n' http://127.0.0.1:4173/api/accounts/acc-1
{"created_at":"2026-08-30T20:27:43.188Z","first_name":"Augusta","id":"acc-1","last_name":"King","status":"archived","updated_at":"2026-08-30T20:27:55.802Z"}
[200]
```

The account is **not deleted**: still in `GET /api/accounts`, `status` is
`archived`, and the rendered list marks the row (`<tr class="archived-row">`,
`<span class="status archived">archived</span>`) with no Archive button.

### Pages fetched

- `GET /` — table with both accounts; archived row marked, active row carries
  the inline `POST /accounts/acc-2/archive` form.
- `GET /accounts/new` — create form (`first_name`, `last_name`).
- `GET /accounts/acc-2/edit` — prefilled form plus the archive control.
- `GET /accounts/acc-1/edit` — archived notice, no archive control.

### Error paths

```sh
$ curl -sS -w '[%{http_code}]\n' -X POST http://127.0.0.1:4173/accounts \
    --data 'first_name=&last_name=X' | grep error
<p class="error">Both first_name and last_name are required.</p>
[422]
$ curl -sS -o /dev/null -w '[%{http_code}]\n' -X POST http://127.0.0.1:4173/accounts/acc-99/archive
[404]
$ curl -sS -o /dev/null -w '[%{http_code}]\n' -X POST http://127.0.0.1:4173/accounts \
    -H 'content-type: application/json' -d '{"first_name":"a","last_name":"b"}'
[415]
$ curl -sS -o /dev/null -w '[%{http_code}]\n' http://127.0.0.1:4173/nope
[404]
```

### Lifecycle and random port

```sh
$ node server.js                    # no --port
gateforge example app listening on http://127.0.0.1:38273
$ kill -TERM $! && wait $!; echo $? # graceful shutdown
0
$ node server.js --port abc; echo $?
error: --port must be an integer in [1, 65535], got "abc"
2
```

All observed outputs above were produced by the commands shown against the
running server on 2026-08-30.
