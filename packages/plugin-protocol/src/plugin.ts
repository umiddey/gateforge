/**
 * GPP/2 plugin SDK (TypeScript side): the reference client for plugin
 * authors. Performs the `hello`/`ready` handshake, validates host frames
 * (protocolVersion, pinned identity, seq order, digest), answers
 * `discover` requests through a user handler, and completes the
 * `shutdown`/`bye` handshake.
 *
 * I/O is injectable so the SDK can be driven in-process by tests; in a
 * real plugin it runs over `process.stdin`/`process.stdout`.
 */
import { createInterface } from 'node:readline';
import { isJsonValue, type JsonValue } from '@gateforge/core';
import { FrameJsonError, ProtocolFailure, SchemaError } from './codes.js';
import { encodeFrame, extractLines, parseLine, verifyEnvelope, verifyPayload } from './framing.js';
import { PROTOCOL_VERSION, REQUIRED_CAPABILITY, type MessageType } from './schema.js';

/** What a plugin's discover handler must return. */
export interface DiscoveryResult {
  resources: JsonValue[];
  unresolved: JsonValue[];
  findings: JsonValue[];
}

/** User-implemented discovery callback. Throw to answer with an `error` frame. */
export type DiscoverHandler = (paths: readonly string[]) => Promise<DiscoveryResult> | DiscoveryResult;

/** Options for {@link servePlugin}. */
export interface ServePluginOptions {
  /** This plugin's declared identity (echoed on every frame). */
  pluginId: string;
  /** This plugin's declared version (pinned by the host at the handshake). */
  pluginVersion: string;
  /** Declared capabilities (default: `['discover']`). */
  capabilities?: readonly string[];
  /** Byte source for host frames (default: `process.stdin`). */
  input?: AsyncIterable<Uint8Array>;
  /** Sink for plugin frames (default: `process.stdout`). */
  output?: { write(chunk: Uint8Array | string): unknown };
  /** Line cap in bytes (default: 8 MiB). */
  maxLineBytes?: number;
}

/** Message types a plugin may legally receive from the host. */
const HOST_TYPES: readonly MessageType[] = ['ready', 'discover', 'shutdown'];

/**
 * Runs the plugin side of a GPP/2 session until the host sends `shutdown`
 * (answered with `bye`) or closes stdin. Throws a {@link ProtocolFailure}
 * if the host violates the protocol (after emitting a session-fatal
 * `error` frame so the host can name the cause).
 */
export async function servePlugin(handler: DiscoverHandler, options: ServePluginOptions): Promise<void> {
  const identity = { pluginId: options.pluginId, pluginVersion: options.pluginVersion };
  const capabilities = options.capabilities ?? [REQUIRED_CAPABILITY];
  const maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;
  const write = (line: string): void => {
    options.output?.write(line);
  };

  let seq = 0;
  let frameNo = 0;
  const send = (type: MessageType, payload: JsonValue): void => {
    write(encodeFrame(identity, type, ++seq, payload));
  };

  // Fail closed: emit a session-fatal error frame (valid envelope, so the
  // host's digest check passes and it can name the plugin's cause), then
  // surface the failure to the caller.
  const fatal = (failure: ProtocolFailure): never => {
    try {
      write(
        encodeFrame(identity, 'error', ++seq, {
          code: failure.code,
          message: failure.message,
        }),
      );
    } catch {
      // stdout is gone; the throw below still reports the cause.
    }
    throw failure;
  };

  send('hello', { capabilities: [...capabilities] });

  let expectedSeq = 1;
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  for await (const chunk of options.input ?? processStdin()) {
    const buf = Buffer.from(chunk);
    buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);
    if (buffer.length > maxLineBytes) {
      fatal(
        new FrameJsonError(
          `host frame exceeds the ${Math.floor(maxLineBytes / (1024 * 1024))} MiB cap ` +
            `(${buffer.length} bytes without a newline)`,
          { frameNo: frameNo + 1 },
        ),
      );
    }
    const { lines, rest } = extractLines(buffer);
    buffer = rest;

    for (const raw of lines) {
      frameNo += 1;
      let envelope;
      try {
        envelope = verifyEnvelope(parseLine(raw, frameNo, 'a host frame'), frameNo, {
          pinnedId: options.pluginId,
          pinnedVersion: options.pluginVersion,
          expectedSeq,
        });
        if (!HOST_TYPES.includes(envelope.type)) {
          throw new SchemaError(
            `frame ${frameNo}: host sent plugin-only message type ${JSON.stringify(envelope.type)}`,
            { frameNo },
          );
        }
      } catch (error) {
        if (error instanceof ProtocolFailure) fatal(error);
        throw error;
      }
      const payload = verifyPayload(envelope, frameNo);
      expectedSeq = envelope.seq + 1;

      switch (envelope.type) {
        case 'ready':
          continue;
        case 'discover': {
          const { requestId, paths } = payload as { requestId: string; paths: string[] };
          try {
            const result = await handler(paths);
            for (const key of ['resources', 'unresolved', 'findings'] as const) {
              if (!isJsonValue(result[key])) {
                throw new SchemaError(`discover handler returned non-JSON "${key}"`);
              }
            }
            send('result', {
              requestId,
              resources: result.resources,
              unresolved: result.unresolved,
              findings: result.findings,
            });
          } catch (error) {
            // Request-scoped failure: the session stays alive; the host
            // decides whether to continue.
            send('error', {
              requestId,
              code: 'E_PLUGIN_INTERNAL',
              message: error instanceof Error ? error.message : String(error),
            });
          }
          continue;
        }
        case 'shutdown':
          send('bye', {});
          return;
      }
    }
  }
}

/** Reads the process stdin line-by-line (default input). */
async function* processStdin(): AsyncIterable<Uint8Array> {
  yield* createInterface({ input: process.stdin, crlfDelay: Infinity }) as unknown as AsyncIterable<Uint8Array>;
}

export { PROTOCOL_VERSION };

