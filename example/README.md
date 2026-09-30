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
run started at the root does not see it. Run it from there (the verifier key is
required and must live outside the repository, as in the quickstart's step 6):

```sh
$ cd behavior
$ gateforge tests discover
test catalog: discovered=3 unresolved=0 parseErrors=0 inventoryComplete=true

$ gateforge tests suggest
suggest: 3 obligation(s) considered (3 in all scope), 0 mapping problem(s), 0 suggestion(s)

$ gateforge test-gates --changed
```

`test-gates` supervises the three committed `evidence.prove` cases through the
loopback witness and a real Chromium. Honest status of this repository today: in a
fresh copy of `example/behavior/` the run does not seal a receipt — it exits 1, and
every failing test prints its own next line, for example

```text
instance 'playwright:chromium:e2e/behavior-proof.spec.js:admin editor updates an account' failed on attempt 1 — the whole run fails. Run `gateforge explain playwright:chromium:e2e/behavior-proof.spec.js:admin editor updates an account`. [TEST_FAILED]
```

Run the `gateforge explain <test>` line it prints before re-running. This example is
a verification fixture, not a green reference run.

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
