# @gate-forge/plugin-protocol — GPP/3

The hardened Gateforge Plugin Protocol (version 3): newline-delimited JSON
framing over a plugin subprocess's stdin/stdout, with a pinned handshake,
per-message digests, schema-generated payload validation, and fail-closed
single-cause diagnostics on every violation (ADR 0002, decision D3).

Lineage: GPP/1 spike (`spikes/plugin-protocol/spec.md`, `host/host.py`,
`plugins/_lib.js`) proved the transport; GPP/2 added `pluginVersion` pinning,
the per-message `digest`, and zod-generated validation; GPP/3 (ADR 0003 D6)
adds the mandatory `classificationSignals` array to every `result` payload —
inside the digest-checked envelope. There is no GPP/2 compatibility path: a
GPP/2 peer fails closed at the handshake with `E_PROTOCOL_VERSION` naming both
versions, before any discovery runs.

## Envelope (pin #5)

Every frame is one line (`\n`-delimited, UTF-8, 8 MiB cap per line):

```json
{
  "protocolVersion": 3,
  "pluginId": "pack-sqlalchemy",
  "pluginVersion": "1.0.0",
  "type": "result",
  "seq": 2,
  "payload": { "…": "…" },
  "digest": "<64 lowercase hex chars>"
}
```

`digest = sha256(canonical({type, seq, payload}))` over GF-canonical-JSON
(`@gate-forge/core`'s `sha256Canonical`): UTF-8, recursively key-sorted, no
whitespace, integers plain. The handshake (`hello`/`ready`) pins
`protocolVersion`, `pluginId`, and `pluginVersion`; every later frame is
checked against the pinned identity. `seq` is per-direction, 1-based,
strictly sequential.

## Message catalog

| type       | direction      | payload                                                              |
| ---------- | -------------- | -------------------------------------------------------------------- |
| `hello`    | plugin → host  | `{capabilities: string[]}` (non-empty; host requires `"discover"`)    |
| `ready`    | host → plugin  | `{}`                                                                 |
| `discover` | host → plugin  | `{requestId: string, paths: string[]}` (repo-relative, no `..`)       |
| `result`   | plugin → host  | `{requestId, resources[], unresolved[], findings[], classificationSignals[]}` |
| `error`    | both           | `{requestId?, code, message}` — with `requestId`: request-scoped; without: session-fatal |
| `shutdown` | host → plugin  | `{}`                                                                 |
| `bye`      | plugin → host  | `{}` — then the plugin exits 0                                        |

Session shape: one spawn, one handshake, many lock-step discovers (at most
one outstanding request), one shutdown handshake. `result.resources`
matches `@gate-forge/core`'s `ResourceSchema`; `result.unresolved` matches
`UnresolvedReasonSchema`; `findings` are `{code, detail, locations[]}`
(e.g. `DUPLICATE_TABLE_NAME`); `result.classificationSignals` matches
`@gate-forge/core`'s `ClassificationSignalSchema` (ADR 0003 D1). The field is
mandatory since the version bump — a detector without signal support sends
`[]`, and its resources fall back to conservative classification defaults. A
result omitting the field fails `E_SCHEMA` (no unversioned optional-field
compatibility). Payload zod schemas live in `src/schema.ts` and are enforced
on receive. Signals never travel outside the digest-checked envelope.

## Capabilities

`hello.capabilities` is a non-empty list; the host requires `"discover"`.
GPP/3 defines one additional capability a plugin MAY declare:

- `classification-signals` — the plugin's discovery handler emits
  classification-signal facts. The host does NOT require it; the capability
  states what the `result` payload may contain, never less.

## Failure codes

Every violation is a distinct error class (`src/codes.ts`), fails the
session closed (plugin killed), and renders one actionable diagnostic —
frame number, message type, offending field, expected vs got — never a
stack dump:

```
[plugin-protocol] FAIL E_PROTOCOL_VERSION: frame 1: envelope protocolVersion=2 but the host speaks 3
[plugin-protocol] offending frame: {"protocolVersion":2,…}
```

| code                 | trigger                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `E_PROTOCOL_VERSION` | envelope/handshake `protocolVersion` ≠ 3 (a GPP/2 peer fails here, before discovery) |
| `E_UNKNOWN_PLUGIN`   | `pluginId`/`pluginVersion` differs from the pinned registration (GF-18) |
| `E_FRAME_JSON`       | empty line, invalid JSON, non-object frame, or line over the 8 MiB cap |
| `E_UNKNOWN_TYPE`     | envelope `type` not in the catalog                                    |
| `E_SCHEMA`           | missing/mistyped field, digest mismatch, seq gap, wrong phase, wrong `requestId`, missing `classificationSignals` |
| `E_EOF`              | plugin stream ended before the expected frame (exit code reported)    |
| `E_TIMEOUT`          | no expected frame within the watchdog budget; plugin killed (SIGKILL) |
| `E_PLUGIN_ERROR`     | plugin answered a request (or the session) with an `error` frame      |
| `E_EXIT_STATUS`      | plugin exited nonzero (or hung) after a clean `bye`                   |

## Migrating a GPP/2 plugin

1. Bump every envelope your plugin builds to `protocolVersion: 3` (the SDKs
   export the pinned `PROTOCOL_VERSION` — use it instead of literals).
2. Return `classificationSignals: []` (or real signal facts) from your
   discover handler. The TS SDK type and the Python `serve()` docstring pin
   the shape; the wire rejects the field's absence.
3. Optionally declare the `classification-signals` capability.

A pre-migration plugin fails with
`E_PROTOCOL_VERSION: envelope protocolVersion=2 but the host speaks 3` —
the expected-versus-received diagnostic names the exact version delta.

## Writing a plugin

### TypeScript

```ts
import { servePlugin } from '@gate-forge/plugin-protocol';

await servePlugin(
  async (paths) => ({
    resources: scanForResources(paths),
    unresolved: [],
    findings: [],
    classificationSignals: emitSignals(paths), // [] when unsupported
  }),
  { pluginId: 'my-detector', pluginVersion: '1.0.0' },
);
```

`servePlugin` performs the handshake, validates host frames (digest, seq,
identity), answers `discover` through your handler (a throw becomes a
request-scoped `error` frame), and completes the shutdown handshake. I/O is
injectable (`input`/`output`) for tests.

### Python (stdlib only)

```python
from gateforge_plugin import serve

def discover(paths):
    return {"resources": scan(paths), "unresolved": [], "findings": [],
            "classificationSignals": signals(paths)}  # [] when unsupported

raise SystemExit(serve("my-detector", "1.0.0", discover))
```

`python/gateforge_plugin/__init__.py` is the client module; the package
ships the Python side as source (`python/`) — plugins add it to `sys.path`
(see `python/plugins/reference_detector.py`) or install it.

## Driving plugins (engine side)

```ts
import { PluginSession } from '@gate-forge/plugin-protocol';

const session = new PluginSession({
  command: ['node', 'plugin.js', repoRoot],
  pluginId: 'my-detector',      // pinned at the handshake
  pluginVersion: '1.0.0',
  timeouts: { handshakeMs: 10_000, requestMs: 10_000, shutdownMs: 5_000 },
});
await session.start();
const outcome = await session.discover(['src/routes.py']); // repeatable, lock-step
await session.shutdown();                                   // bye + exit 0
```

Watchdogs run per read; any failure kills the plugin. `dispose()` is a
best-effort kill that never throws. For tests, `maxLineBytes` and all three
timeouts are overridable.

## Layout

- `src/host.ts` — engine-side host (`PluginSession`)
- `src/plugin.ts` — TypeScript plugin SDK (`servePlugin`)
- `src/schema.ts` — message catalog + zod payload schemas
- `src/framing.ts` — line framing, envelope verify/build (shared by both sides)
- `src/codes.ts` — failure classes + `formatDiagnostic`
- `python/gateforge_plugin/` — Python client (stdlib only)
- `python/plugins/reference_detector.py` — Python reference detector
- `test/fixtures/` — one-fault-per-plugin fixtures powering the E_* tests
  (`app/routes.gfx` is the shared trivial fixture format; `plugin_gpp2_peer.mjs`
  is the pre-cutover peer used to prove the fail-closed handshake)
- `test/host.test.ts` — GF-12 + GF-18 mechanics: every E_* code with
  diagnostic assertions, green multi-discover session, determinism
- `test/cross-language.test.ts` — TS host x Python plugin interop
  (byte-identical discovery documents incl. signals)
- `test/plugin-sdk.test.ts` — SDK envelope/digest correctness

Requires Node >= 20 (TS side), Python >= 3.12 (Python side); no network at
any point.
