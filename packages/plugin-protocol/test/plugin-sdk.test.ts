/**
 * TS plugin SDK suite: drives servePlugin in-process with scripted host
 * frames and asserts the emitted envelopes byte-for-byte (digests computed
 * with @gateforge/core's sha256Canonical, the same primitive the host and
 * every real client use).
 */
import { describe, expect, test } from 'vitest';
import { sha256Canonical, type JsonValue } from '@gateforge/core';
import {
  FrameJsonError,
  ProtocolVersionError,
  SchemaError,
  servePlugin,
  type DiscoveryResult,
} from '../src/index.js';

const IDENTITY = { pluginId: 'ts-sdk-plugin', pluginVersion: '2.0.0' } as const;

/** Builds one host frame line exactly as the real host does. */
function hostFrame(type: string, seq: number, payload: JsonValue): string {
  const digest = sha256Canonical({ type, seq, payload });
  return `${JSON.stringify({
    protocolVersion: 2,
    pluginId: IDENTITY.pluginId,
    pluginVersion: IDENTITY.pluginVersion,
    type,
    seq,
    payload,
    digest,
  })}\n`;
}

/** Parses emitted stdout into envelope objects. */
function outputFrames(out: string): Array<Record<string, unknown>> {
  return out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function discoverResult(): DiscoveryResult {
  return {
    resources: [
      {
        schemaVersion: 1,
        id: 'web.routes:GET /health',
        kind: 'http-route',
        source: 'src/app.ts',
        location: { file: 'src/app.ts', line: 12, col: 2 },
        detectorVersion: '2.0.0',
        attributes: { method: 'GET', path: '/health' },
      },
    ],
    unresolved: [],
    findings: [],
  };
}

async function drive(lines: string[], handler = discoverResult): Promise<string> {
  const chunks: string[] = [];
  const input = (async function* (): AsyncIterable<Uint8Array> {
    yield Buffer.from(lines.join(''), 'utf8');
  })();
  await servePlugin(handler, {
    ...IDENTITY,
    input,
    output: { write: (chunk) => void chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')) },
  });
  return chunks.join('');
}

describe('servePlugin', () => {
  test('emits a digest-correct hello, answers discovers, and says bye', async () => {
    const out = await drive([
      hostFrame('ready', 1, {}),
      hostFrame('discover', 2, { requestId: 'req-1', paths: ['src/app.ts'] }),
      hostFrame('discover', 3, { requestId: 'req-2', paths: ['src/app.ts'] }),
      hostFrame('shutdown', 4, {}),
    ]);
    const frames = outputFrames(out);
    expect(frames).toHaveLength(4);

    const [hello, first, second, bye] = frames;
    expect(hello).toMatchObject({
      protocolVersion: 2,
      pluginId: IDENTITY.pluginId,
      pluginVersion: IDENTITY.pluginVersion,
      type: 'hello',
      seq: 1,
      payload: { capabilities: ['discover'] },
    });
    expect(hello?.digest).toBe(
      sha256Canonical({ type: 'hello', seq: 1, payload: { capabilities: ['discover'] } }),
    );
    expect(first).toMatchObject({ type: 'result', seq: 2, payload: { requestId: 'req-1' } });
    expect(first?.digest).toBe(
      sha256Canonical({ type: 'result', seq: 2, payload: first?.payload as JsonValue }),
    );
    expect(second).toMatchObject({ type: 'result', seq: 3, payload: { requestId: 'req-2' } });
    expect(bye).toMatchObject({ type: 'bye', seq: 4, payload: {} });
  });

  test('a throwing handler answers with a request-scoped error and keeps serving', async () => {
    let calls = 0;
    const out = await drive(
      [
        hostFrame('ready', 1, {}),
        hostFrame('discover', 2, { requestId: 'req-1', paths: ['gone.gfx'] }),
        hostFrame('discover', 3, { requestId: 'req-2', paths: ['gone.gfx'] }),
        hostFrame('shutdown', 4, {}),
      ],
      () => {
        calls += 1;
        if (calls === 1) throw new Error('fixture not found: gone.gfx');
        return discoverResult();
      },
    );
    const frames = outputFrames(out);
    expect(frames[1]).toMatchObject({
      type: 'error',
      seq: 2,
      payload: { requestId: 'req-1', code: 'E_PLUGIN_INTERNAL', message: 'fixture not found: gone.gfx' },
    });
    expect(frames[2]).toMatchObject({ type: 'result', seq: 3, payload: { requestId: 'req-2' } });
  });

  test('a host frame with a broken digest fails closed with a fatal error frame', async () => {
    const bad = hostFrame('ready', 1, {});
    const parsed = JSON.parse(bad) as Record<string, unknown>;
    parsed.digest = '0'.repeat(64);
    const hostile = `${JSON.stringify(parsed)}\n`;
    await expect(
      drive([hostile, hostFrame('shutdown', 2, {})]),
    ).rejects.toBeInstanceOf(SchemaError);
  });

  test('a host frame with a seq gap fails closed', async () => {
    await expect(
      drive([hostFrame('ready', 7, {})]),
    ).rejects.toBeInstanceOf(SchemaError);
  });

  test('a host frame with a wrong protocolVersion fails closed', async () => {
    const line = hostFrame('ready', 1, {});
    const parsed = JSON.parse(line) as Record<string, unknown>;
    parsed.protocolVersion = 1;
    await expect(drive([`${JSON.stringify(parsed)}\n`])).rejects.toBeInstanceOf(ProtocolVersionError);
  });

  test('a host frame that is not valid JSON fails closed with E_FRAME_JSON', async () => {
    await expect(drive(['not json\n'])).rejects.toBeInstanceOf(FrameJsonError);
  });
});
