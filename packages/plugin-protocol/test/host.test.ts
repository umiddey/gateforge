/**
 * GPP/3 host suite (GF-12 + GF-18 mechanics): every E_* code is exercised
 * by a fixture plugin that commits exactly one fault, and the test asserts
 * the single-cause diagnostic text. Plus the green persistent session
 * (>= 2 sequential discovers over one spawn), determinism, the GPP/2-peer
 * rejection (ADR 0003 D6: fail closed BEFORE discovery), and the
 * mandatory-signals schema rule.
 */
import { describe, expect, test } from 'vitest';
import {
  EofError,
  ExitStatusError,
  FrameJsonError,
  PluginError,
  ProtocolFailure,
  PluginSession,
  ProtocolVersionError,
  SchemaError,
  TimeoutError,
  UnknownPluginError,
  UnknownTypeError,
  formatDiagnostic,
  isProtocolFailure,
  type PluginSpawnOptions,
} from '../src/index.js';
import {
  EXPECTED_FINDINGS,
  EXPECTED_RESOURCES,
  EXPECTED_SIGNALS,
  FIXTURE_ROOT,
  jsPluginOptions,
} from './helpers.js';

/**
 * Drives a fixture plugin through `steps` and returns the typed failure
 * that eventually surfaces (or fails the test if the session succeeds).
 */
async function runFaultySession(
  plugin: string,
  steps: (session: PluginSession) => Promise<unknown>,
  overrides: Partial<PluginSpawnOptions> = {},
): Promise<unknown> {
  const session = new PluginSession(jsPluginOptions(plugin, overrides));
  try {
    await steps(session);
  } finally {
    await session.dispose();
  }
  return undefined;
}

async function expectFailure(
  plugin: string,
  steps: (session: PluginSession) => Promise<unknown>,
  overrides: Partial<PluginSpawnOptions> = {},
): Promise<ProtocolFailure> {
  const outcome: unknown = await runFaultySession(plugin, steps, overrides).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (outcome === undefined) {
    throw new Error(`expected session with ${plugin} to fail closed, but it succeeded`);
  }
  if (!(outcome instanceof ProtocolFailure)) {
    throw new Error(`expected a ProtocolFailure from ${plugin}, got: ${String(outcome)}`);
  }
  return outcome;
}

describe('green persistent session', () => {
  test('handshake, two sequential discovers over one spawn, clean shutdown', async () => {
    const session = new PluginSession(jsPluginOptions('plugin_ok.mjs'));
    try {
      await session.start();
      const first = await session.discover(['app/routes.gfx']);
      expect(first.resources).toEqual(EXPECTED_RESOURCES);
      expect(first.unresolved).toEqual([]);
      expect(first.findings).toEqual(EXPECTED_FINDINGS);
      // GPP/3: the fixture plugin derives one exposure signal per route.
      expect(first.classificationSignals).toEqual(
        EXPECTED_SIGNALS.map((signal) => ({
          ...signal,
          source: 'js-fixture-detector',
          detector: { id: 'js-fixture-detector', version: '1.0.0' },
        })),
      );
      // Lock-step: a second request on the SAME spawned process.
      const second = await session.discover(['app/routes.gfx']);
      expect(second).toEqual(first);
      // Multi-path request: deterministic concatenation in request order.
      const multi = await session.discover(['app/routes.gfx', 'app/routes.gfx']);
      expect(multi.resources).toEqual([...EXPECTED_RESOURCES, ...EXPECTED_RESOURCES]);
      await session.shutdown(); // resolves only after exit 0
    } finally {
      await session.dispose();
    }
  });

  test('determinism: two independent sessions produce byte-identical results', async () => {
    const run = async (): Promise<string> => {
      const session = new PluginSession(jsPluginOptions('plugin_ok.mjs'));
      try {
        await session.start();
        const outcome = await session.discover(['app/routes.gfx']);
        return JSON.stringify(outcome);
      } finally {
        await session.dispose();
      }
    };
    expect(await run()).toBe(await run());
  });

  test('discover request payload carries paths under the fixture root', async () => {
    // A path escaping the root is answered with a request-scoped error
    // (plugin-side validation), which the host maps to E_PLUGIN_ERROR.
    const failure = await expectFailure('plugin_ok.mjs', async (session) => {
      await session.start();
      await session.discover(['../secrets/routes.gfx']);
    });
    expect(isProtocolFailure(failure, 'E_PLUGIN_ERROR')).toBe(true);
    expect((failure as PluginError).message).toMatch(/\.\./);
  });
});

describe('E_PROTOCOL_VERSION', () => {
  test('hello declaring protocolVersion 1 fails closed naming expected vs got', async () => {
    const failure = await expectFailure('plugin_protocol_version_mismatch.mjs', (s) => s.start());
    expect(failure).toBeInstanceOf(ProtocolVersionError);
    const f = failure as ProtocolVersionError;
    expect(f.code).toBe('E_PROTOCOL_VERSION');
    expect(f.frameNo).toBe(1);
    expect(f.message).toContain('protocolVersion=1');
    expect(f.message).toContain('host speaks 3');
    expect(formatDiagnostic(f)).toMatch(/^\[plugin-protocol\] FAIL E_PROTOCOL_VERSION: frame 1: /);
  });
});

describe('GPP/3 cutover (ADR 0003 D6)', () => {
  test('a GPP/2 peer fails closed at the handshake, before any discovery', async () => {
    const failure = await expectFailure('plugin_gpp2_peer.mjs', (s) => s.start());
    expect(failure).toBeInstanceOf(ProtocolVersionError);
    const f = failure as ProtocolVersionError;
    expect(f.code).toBe('E_PROTOCOL_VERSION');
    expect(f.frameNo).toBe(1);
    expect(f.message).toContain('protocolVersion=2');
    expect(f.message).toContain('host speaks 3');
  });

  test('a result omitting classificationSignals is a schema violation (no GPP/2 compatibility)', async () => {
    const failure = await expectFailure('plugin_missing_signals.mjs', async (s) => {
      await s.start();
      await s.discover(['app/routes.gfx']);
    });
    expect(failure).toBeInstanceOf(SchemaError);
    const f = failure as SchemaError;
    expect(f.frameNo).toBe(2);
    expect(f.message).toContain('type result');
    expect(f.message).toContain('classificationSignals');
  });

  test('a malformed signal element is a schema violation naming the offending path', async () => {
    const failure = await expectFailure('plugin_bad_signal.mjs', async (s) => {
      await s.start();
      await s.discover(['app/routes.gfx']);
    });
    expect(failure).toBeInstanceOf(SchemaError);
    const f = failure as SchemaError;
    expect(f.frameNo).toBe(2);
    expect(f.message).toContain('type result');
    // Single-cause diagnostic points INSIDE the signals array at the
    // first violated rule (strict schema rejects the smuggled field or
    // the missing location — either way the payload fails closed).
    expect(f.message).toMatch(/classificationSignals\.0\./);
  });
});

describe('E_UNKNOWN_PLUGIN', () => {
  test('hello declaring an unknown pluginId names both ids (GF-18)', async () => {
    const failure = await expectFailure('plugin_unknown_plugin_id.mjs', (s) => s.start());
    expect(failure).toBeInstanceOf(UnknownPluginError);
    const f = failure as UnknownPluginError;
    expect(f.code).toBe('E_UNKNOWN_PLUGIN');
    expect(f.message).toContain('"impostor-detector"');
    expect(f.message).toContain('"js-fixture-detector"');
  });

  test('hello declaring an unknown pluginVersion names expected vs got (GF-18)', async () => {
    const failure = await expectFailure('plugin_unknown_plugin_version.mjs', (s) => s.start());
    expect(failure).toBeInstanceOf(UnknownPluginError);
    const f = failure as UnknownPluginError;
    expect(f.code).toBe('E_UNKNOWN_PLUGIN');
    expect(f.message).toContain('"9.9.9"');
    expect(f.message).toContain('"1.0.0"');
  });
});

describe('E_FRAME_JSON', () => {
  test('non-JSON stdout line names the frame and the JSON fault', async () => {
    const failure = await expectFailure('plugin_bad_json.mjs', (s) => s.start());
    expect(failure).toBeInstanceOf(FrameJsonError);
    const f = failure as FrameJsonError;
    expect(f.frameNo).toBe(1);
    expect(f.message).toContain('frame 1');
    expect(f.message).toContain('not valid JSON');
    expect(f.rawLine).toBe('this is not json');
    expect(formatDiagnostic(f)).toContain('[plugin-protocol] offending frame: this is not json');
  });

  test('valid JSON that is not an object is a framing violation', async () => {
    const failure = await expectFailure('plugin_not_object.mjs', (s) => s.start());
    expect(failure).toBeInstanceOf(FrameJsonError);
    expect((failure as FrameJsonError).message).toContain('not an object (got number)');
  });

  test('a stdout line over the 8 MiB cap violates framing before parsing', { timeout: 30_000 }, async () => {
    // Spawning a child that materializes an 8 MiB line can exceed the
    // default timeout under full-suite load (CI flake) — the assertion
    // is about framing, not speed, so give it headroom.
    const failure = await expectFailure('plugin_oversize_line.mjs', (s) => s.start());
    expect(failure).toBeInstanceOf(FrameJsonError);
    const f = failure as FrameJsonError;
    expect(f.message).toContain('8 MiB cap');
    expect(f.message).toMatch(/\d+ bytes without a newline/);
  });
});

describe('E_UNKNOWN_TYPE', () => {
  test('a digest-valid frame with an off-catalog type lists the catalog', async () => {
    const failure = await expectFailure('plugin_unknown_type.mjs', async (s) => {
      await s.start();
      await s.discover(['app/routes.gfx']);
    });
    expect(failure).toBeInstanceOf(UnknownTypeError);
    const f = failure as UnknownTypeError;
    expect(f.code).toBe('E_UNKNOWN_TYPE');
    expect(f.frameNo).toBe(2);
    expect(f.message).toContain('"resulkt"');
    expect(f.message).toContain('known types: hello, ready, discover, result, error, shutdown, bye');
  });
});

describe('E_SCHEMA', () => {
  test('result missing the resources field names the offending path', async () => {
    const failure = await expectFailure('plugin_missing_field.mjs', async (s) => {
      await s.start();
      await s.discover(['app/routes.gfx']);
    });
    expect(failure).toBeInstanceOf(SchemaError);
    const f = failure as SchemaError;
    expect(f.frameNo).toBe(2);
    expect(f.message).toContain('type result');
    expect(f.message).toContain('resources');
  });

  test('a tampered digest names expected vs got (GF-18)', async () => {
    const failure = await expectFailure('plugin_digest_tamper.mjs', async (s) => {
      await s.start();
      await s.discover(['app/routes.gfx']);
    });
    expect(failure).toBeInstanceOf(SchemaError);
    const f = failure as SchemaError;
    expect(f.message).toContain('digest mismatch');
    expect(f.message).toContain('expected ');
    expect(f.message).toContain('sha256(canonical({type, seq, payload}))');
  });

  test('a jumped seq number names got vs expected', async () => {
    const failure = await expectFailure('plugin_bad_seq.mjs', async (s) => {
      await s.start();
      await s.discover(['app/routes.gfx']);
    });
    expect(failure).toBeInstanceOf(SchemaError);
    expect((failure as SchemaError).message).toContain('seq 99 but expected 2');
  });

  test('a result echoing a foreign requestId does not match the outstanding request', async () => {
    const failure = await expectFailure('plugin_wrong_request_id.mjs', async (s) => {
      await s.start();
      await s.discover(['app/routes.gfx']);
    });
    expect(failure).toBeInstanceOf(SchemaError);
    const f = failure as SchemaError;
    expect(f.message).toContain('"req-999"');
    expect(f.message).toContain('"req-1"');
  });
});

describe('E_EOF', () => {
  test('mid-stream exit reports the exit code and frames received', async () => {
    const failure = await expectFailure('plugin_midstream_exit.mjs', async (s) => {
      await s.start();
      const first = await s.discover(['app/routes.gfx']);
      expect(first.resources).toEqual(EXPECTED_RESOURCES); // first request succeeds
      await s.discover(['app/routes.gfx']); // plugin exits here
    });
    expect(failure).toBeInstanceOf(EofError);
    const f = failure as EofError;
    expect(f.code).toBe('E_EOF');
    expect(f.message).toContain('exit code 3');
    expect(f.message).toContain('2 complete frame(s) received');
  });
});

describe('E_TIMEOUT', () => {
  test('a plugin that never answers is killed by the watchdog', async () => {
    const failure = await expectFailure(
      'plugin_slow.mjs',
      async (s) => {
        await s.start();
        await s.discover(['app/routes.gfx']);
      },
      { timeouts: { handshakeMs: 5_000, requestMs: 400, shutdownMs: 5_000 } },
    );
    expect(failure).toBeInstanceOf(TimeoutError);
    const f = failure as TimeoutError;
    expect(f.code).toBe('E_TIMEOUT');
    expect(f.message).toContain('no result or error for request "req-1" within 400ms');
    expect(f.message).toContain('SIGKILL');
  }, 15_000);
});

describe('E_PLUGIN_ERROR', () => {
  test('a request-scoped error frame surfaces code and message', async () => {
    const failure = await expectFailure('plugin_request_error.mjs', async (s) => {
      await s.start();
      await s.discover(['app/routes.gfx']);
    });
    expect(failure).toBeInstanceOf(PluginError);
    const f = failure as PluginError;
    expect(f.code).toBe('E_PLUGIN_ERROR');
    expect(f.frameNo).toBe(2);
    expect(f.message).toContain('E_NO_ROUTES');
    expect(f.message).toContain('no route tables found');
    expect(f.message).toContain('"req-1"');
  });
});

describe('E_EXIT_STATUS', () => {
  test('nonzero exit after a clean bye names the code (expected 0)', async () => {
    const failure = await expectFailure('plugin_exit_nonzero.mjs', async (s) => {
      await s.start();
      await s.discover(['app/routes.gfx']);
      await s.shutdown();
    });
    expect(failure).toBeInstanceOf(ExitStatusError);
    const f = failure as ExitStatusError;
    expect(f.code).toBe('E_EXIT_STATUS');
    expect(f.message).toContain('exited with code 7 after a clean bye (expected 0)');
  });
});

describe('diagnostic hygiene', () => {
  test('formatDiagnostic never emits stack frames and truncates the raw frame', async () => {
    const failure = await expectFailure('plugin_bad_json.mjs', (s) => s.start());
    const text = formatDiagnostic(failure as FrameJsonError);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^\[plugin-protocol\] FAIL E_FRAME_JSON: frame 1: /);
    expect(text).not.toMatch(/^\s+at /m);
    for (const line of lines) {
      if (line.startsWith('[plugin-protocol] offending frame:')) {
        expect(line.length).toBeLessThanOrEqual('[plugin-protocol] offending frame: '.length + 201);
      }
    }
  });

  test('E_EOF keeps the failure class even when the plugin exits silently', async () => {
    const failure = await expectFailure('plugin_midstream_exit.mjs', async (s) => {
      await s.start();
      await s.discover(['app/routes.gfx']);
      await s.discover(['missing.gfx']); // exits before answering
    });
    expect((failure as EofError).code).toBe('E_EOF');
    expect((failure as EofError).message).toContain('exit code 3');
  });

  test('the fixture root resolves relative to the test, not the cwd', () => {
    expect(FIXTURE_ROOT).toContain('plugin-protocol');
  });
});
