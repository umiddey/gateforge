# Webhook receiver — behavior setup from printed lines

A `node:http` receiver that verifies an HMAC-SHA256 signature over the raw
body, records accepted deliveries in a delivery log, and serves a read-only
listing for a witness adapter. `server.js` is the app; everything else here is
the wiring a fresh copy needs to reach a green gate.

## What ships, and what the tool prints

This repository deliberately ships **no** `.gateforge/behavior.yml`, **no**
`.gateforge/test-map.yml` and **no** `specs/` tests: those three are what
Gateforge prints, so following the printed steps is the whole setup.

1. `gateforge init --behavior-packs webhook` writes the behavior scaffold
   (a commented example case — a scaffold is not approval) and prints the
   `behaviorPolicy: .gateforge/behavior.yml` line this repository's existing
   config still needs. Add it.
2. `gateforge next` prints the complete `endpoints:` entry for
   `POST /webhook/stripe` (the three cases the approved policy requires, with
   the compiled case ids), the proof test, and the `.gateforge/test-map.yml`
   entries that map every case to its test. Paste the blocks as printed.
3. `npm run gate` runs the whole gate.

## Running it

```sh
npm install @gate-forge/cli @gate-forge/pack-playwright
npm run gate
```

`npm run gate` owns the run: a free loopback port, a per-run signing secret
(generated, never committed), a runtime verifier key ring in the OS temp
directory, the receiver started behind the loopback attestation proxy, then
`tests discover`, `test-gates --changed` and `check --require-e2e`. It exits
with the check's status.

## The parts that are app-specific

| File | Why the engine needs it |
| --- | --- |
| `fixtures/fixture-detector.mjs` | The receiver is raw `node:http`, so no framework pack can see its route: this states the endpoint and the delivery-log entity, plus their classification. |
| `fixtures/webhook-fixtures.yml` | The recipes `init` and `next` print: the actor, the subject the engine signs and posts, and the row a delivery records. |
| `fixtures/fixture-provider.mjs` | The operator's trusted provider (engine-side only, `GATEFORGE_FIXTURE_PROVIDER`). It provisions the subject and the signing credential. |
| `.gateforge/adapters/deliveries.mjs` | The reviewed observer: entity reads over the app's read-only listing, and the before/after scope read by its own engine-side fetch. |
