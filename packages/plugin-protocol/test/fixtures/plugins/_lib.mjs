// Shared client implementation for the GPP/3 test fixture plugins. Each
// fault plugin is this module plus exactly one deliberate deviation, so
// every host diagnostic stays attributable to a single protocol violation.
// Mirrors the spike lineage (spikes/plugin-protocol/plugins/_lib.js) at
// protocolVersion 3. Determinism: output is a pure function of fixture bytes.
import { createHash } from 'node:crypto';
import { readFileSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';


export const PLUGIN_ID = 'js-fixture-detector';
export const PLUGIN_VERSION = '1.0.0';

/**
 * GF-canonical-JSON (pin #1): UTF-8, recursively key-sorted (UTF-16 code
 * units), no whitespace, integers plain. Byte-compatible with
 * @gateforge/core's canonicalJson — the cross-language digest tests prove it.
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('no canonical form');
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** digest = sha256(canonical({type, seq, payload})) — pin #5. */
export function digestOf(type, seq, payload) {
  return createHash('sha256').update(canonicalJson({ type, seq, payload })).digest('hex');
}

/** Protocol version the fixture plugins speak (the GPP/2-peer fixture overrides it to 2 to prove the fail-closed handshake). */
export const PROTOCOL_VERSION = 3;

/** Builds one full GPP/3 envelope, with per-field fault overrides. */
export function makeEnvelope(plugin, type, seq, payload, overrides = {}) {
  const frame = {
    protocolVersion: overrides.protocolVersion ?? PROTOCOL_VERSION,
    pluginId: overrides.pluginId ?? plugin.id,
    pluginVersion: overrides.pluginVersion ?? plugin.version,
    type: overrides.type ?? type,
    seq: overrides.seq ?? seq,
    payload: overrides.payload ?? payload,
  };
  frame.digest = overrides.digest ?? digestOf(frame.type, frame.seq, frame.payload);
  return frame;
}

/** Writes one frame as a synchronous newline-terminated stdout line. */
export function send(frame) {
  writeSync(1, JSON.stringify(frame) + '\n');
}


/**
 * Parses `.gfx` route fixtures: one `METHOD path` per line, `#` comments.
 * Returns the full result payload pieces (resources + DUPLICATE_ROUTE
 * findings); identical algorithm in the Python reference detector.
 */
export function scanFixture(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new Error(`target must be a relative path under the fixture root, got ${JSON.stringify(rel)}`);
  }
  const text = readFileSync(join(root, rel), 'utf8');
  const resources = [];
  const seen = new Map();
  text.split('\n').forEach((lineText, i) => {
    const line = lineText.trim();
    if (line.length === 0 || line.startsWith('#')) return;
    const spaceAt = line.indexOf(' ');
    if (spaceAt <= 0) throw new Error(`malformed fixture line ${i + 1} in ${rel}: ${JSON.stringify(lineText)}`);
    const method = line.slice(0, spaceAt);
    const routePath = line.slice(spaceAt + 1).trim();
    const resource = {
      schemaVersion: 1,
      id: `web.routes:${method} ${routePath}`,
      kind: 'http-route',
      source: rel,
      location: { file: rel, line: i + 1, col: 0 },
      detectorVersion: PLUGIN_VERSION,
      attributes: { method, path: routePath },
    };
    resources.push(resource);
    const key = `${method} ${routePath}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(resource.location);
  });
  const findings = [];
  for (const key of [...seen.keys()].sort()) {
    const locations = seen.get(key);
    if (locations.length < 2) continue;
    findings.push({
      code: 'DUPLICATE_ROUTE',
      detail: `route '${key}' declared ${locations.length} times`,
      locations,
    });
  }
  return { resources, findings };
}

/**
 * Derives the classification signals for scanned route resources: one
 * `exposure` code-positive signal per route row. Identical algorithm in
 * the Python reference detector — the cross-language suite proves the
 * signal documents are byte-identical.
 */
export function scanSignals(resources) {
  return resources.map((resource) => ({
    schemaVersion: 1,
    target: { resourceId: resource.id },
    dimension: 'exposure',
    assertion: 'route',
    basis: 'code-positive',
    source: PLUGIN_ID,
    location: resource.location,
    detector: { id: PLUGIN_ID, version: PLUGIN_VERSION },
  }));
}

/**
 * Standard serve loop: hello → (discover → result|error)* → shutdown →
 * bye → exit 0. Fault hooks return true when they handled the event.
 */
export async function serve(plugin, opts = {}) {
  const root = opts.root ?? process.argv[2] ?? '.';
  let seq = 0;
  const nextSeq = () => ++seq;

  send(
    makeEnvelope(
      plugin,
      'hello',
      nextSeq(),
      { capabilities: opts.capabilities ?? ['discover'] },
      opts.helloOverrides,
    ),
  );

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.type === 'ready') continue;
    if (frame.type === 'discover') {
      if (opts.onDiscover && opts.onDiscover({ frame, nextSeq, plugin, root })) continue;
      const { requestId, paths } = frame.payload;
      try {
        let resources = [];
        let findings = [];
        let scanned = [];
        for (const rel of paths) {
          const out = scanFixture(root, rel);
          resources = resources.concat(out.resources);
          findings = findings.concat(out.findings);
          scanned = scanned.concat(rel);
        }
        send(
          makeEnvelope(plugin, 'result', nextSeq(), {
            requestId,
            resources,
            unresolved: [],
            findings,
            classificationSignals: scanSignals(resources),
            scannedPaths: scanned,
          }),
        );
      } catch (e) {
        send(
          makeEnvelope(plugin, 'error', nextSeq(), {
            requestId,
            code: 'E_PLUGIN_INTERNAL',
            message: String(e.message),
          }),
        );
      }
    } else if (frame.type === 'shutdown') {
      send(makeEnvelope(plugin, 'bye', nextSeq(), {}));
      if (opts.onShutdown) opts.onShutdown();
      process.exit(0);
    }
  }
}
