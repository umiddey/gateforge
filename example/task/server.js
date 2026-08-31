#!/usr/bin/env node
// Gateforge pack-task example: an in-process background-task runner that
// demonstrates the five obligation contracts the pack claims:
//
//   - task:retry-policy-enforced — flaky task retries up to maxAttempts
//   - task:idempotent             — same idempotency key is deduped
//   -task:terminal-handled        — terminal errors are NOT retried
//   - task:observability-recorded — every execution writes to runs.json
//   - task:duplicate-delivery-handled — duplicate deliveries produce
//                                       exactly one side effect
//
// HTTP surface (node:http, zero deps):
//   GET  /health                   200 OK
//   GET  /tasks                    list of registered task names
//   POST /enqueue                  { name, key?, profile, payload } → 202
//   GET  /runs                     audit-trail rows (the witness adapter target)
//
// Profiles:
//   flaky    — fails on attempts 1..maxAttempts-1, succeeds on the last
//   duplicate — always succeeds; writes a counter under `payload.counter`
//   terminal — throws an AuthError immediately; no retry, terminal record
//   normal   — always succeeds
//
// Usage:
//   node server.js                 random free port
//   node server.js --port 3004     fixed port

import http from 'node:http';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// Domain: in-memory task registry
// ---------------------------------------------------------------------------

/** Per-task configuration. */
const TASKS = {
  'task.email.send': {
    retryPolicy: { maxAttempts: 5, backoff: 'fixed' },
    terminalOn: ['AuthError', 'ValidationError'],
    idempotencyKey: true,
    observability: true,
  },
  'task.billing.refund': {
    retryPolicy: { maxAttempts: 3, backoff: 'exponential' },
    terminalOn: ['AuthError'],
    idempotencyKey: false,
    observability: true,
  },
};

// ---------------------------------------------------------------------------
// Audit trail (`runs.json`)
// ---------------------------------------------------------------------------

/** Absolute path of the audit-trail file (created lazily). */
const RUNS_PATH = join(tmpdir(), 'gateforge-pack-task-runs.json');

/**
 * Reads the audit trail, returning an array. If the file does not
 * exist, returns an empty array (fail-open on first boot).
 */
function readRuns() {
  if (!existsSync(RUNS_PATH)) return [];
  const text = readFileSync(RUNS_PATH, 'utf8');
  if (text.trim().length === 0) return [];
  return JSON.parse(text);
}

/**
 * Persists the audit trail by appending `row` and rewriting the file.
 * Each row records a single execution attempt (or the terminal record).
 */
function appendRun(row) {
  const runs = readRuns();
  runs.push(row);
  writeFileSync(RUNS_PATH, JSON.stringify(runs, null, 2));
}

// ---------------------------------------------------------------------------
// Idempotency store
// ---------------------------------------------------------------------------

/** Per-process idempotency cache: key → recorded outcome. */
const IDEMPOTENCY = new Map();

/** Returns the recorded outcome for `key`, or `null` if absent. */
function lookupIdempotent(key) {
  return IDEMPOTENCY.get(key) ?? null;
}

/** Records the outcome of an idempotency-keyed execution. */
function recordIdempotent(key, outcome) {
  IDEMPOTENCY.set(key, outcome);
}

// ---------------------------------------------------------------------------
// Side-effect counters (for duplicate-delivery proofs)
// ---------------------------------------------------------------------------

/** Per-task side-effect counters. */
const SIDE_EFFECT_COUNTERS = new Map();

/** Increments the side-effect counter for `name` and returns the new value. */
function incrementSideEffect(name) {
  const current = SIDE_EFFECT_COUNTERS.get(name) ?? 0;
  const next = current + 1;
  SIDE_EFFECT_COUNTERS.set(name, next);
  return next;
}

/** Returns the current side-effect counter for `name` (0 if absent). */
function sideEffectCount(name) {
  return SIDE_EFFECT_COUNTERS.get(name) ?? 0;
}

// ---------------------------------------------------------------------------
// Task runner (the five contracts in one place)
// ---------------------------------------------------------------------------

/**
 * Runs one task, honoring the five contracts.
 *
 * Args:
 *   task: The registered task config.
 *   profile: 'flaky' | 'duplicate' | 'terminal' | 'normal'.
 *   payload: Arbitrary payload (counter etc. for duplicate proofs).
 *   key: Idempotency key (optional).
 *   runId: Top-level run identifier (one per enqueue).
 *
 * Returns:
 *   { outcome, attempts, terminal, sideEffectCount, runId, key }
 */
async function runTask(task, profile, payload, key, runId) {
  // 1. Idempotency check (contract: task:idempotent / task:duplicate-delivery-handled)
  if (key !== undefined && key !== null) {
    const prior = lookupIdempotent(key);
    if (prior !== null) {
      // Already ran — record a DEDUPED audit row but DO NOT re-execute the side effect.
      if (task.observability) {
        appendRun({
          runId,
          taskName: Object.keys(TASKS).find((n) => TASKS[n] === task),
          profile,
          key,
          attempt: 0,
          terminal: prior.terminal,
          outcome: prior.outcome,
          sideEffectCount: prior.sideEffectCount,
          deduped: true,
        });
      }
      return prior;
    }
  }

  const maxAttempts = task.retryPolicy.maxAttempts;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt += 1;

    // Profile-driven outcome: terminal fails immediately; flaky fails
    // until the last attempt; normal/duplicate always succeed.
    let shouldFail = false;
    if (profile === 'terminal') {
      shouldFail = true;
    } else if (profile === 'flaky') {
      shouldFail = attempt < maxAttempts;
    }

    try {
      if (shouldFail) {
        const errorType = profile === 'terminal' ? 'AuthError' : 'RetryableError';
        const error = new Error(errorType);
        error.type = errorType;
        throw error;
      }

      // 2. Side effect (contract: task:duplicate-delivery-handled)
      const sideEffect = incrementSideEffect(
        Object.keys(TASKS).find((n) => TASKS[n] === task),
      );

      // 3. Observability (contract: task:observability-recorded)
      if (task.observability) {
        appendRun({
          runId,
          taskName: Object.keys(TASKS).find((n) => TASKS[n] === task),
          profile,
          key,
          attempt,
          terminal: false,
          outcome: 'success',
          sideEffectCount: sideEffect,
          deduped: false,
        });
      }

      const outcome = { outcome: 'success', attempts: attempt, terminal: false, sideEffectCount: sideEffect, runId, key };
      if (key !== undefined && key !== null) recordIdempotent(key, outcome);
      return outcome;
    } catch (error) {
      lastError = error;
      const isTerminal = task.terminalOn.includes(error.type);

      // Observability: record the failure even when retrying.
      if (task.observability) {
        appendRun({
          runId,
          taskName: Object.keys(TASKS).find((n) => TASKS[n] === task),
          profile,
          key,
          attempt,
          terminal: isTerminal,
          outcome: isTerminal ? 'terminal' : 'retry',
          sideEffectCount: sideEffectCount(
            Object.keys(TASKS).find((n) => TASKS[n] === task),
          ),
          deduped: false,
          errorType: error.type,
        });
      }

      // Contract: task:terminal-handled — no more retries on terminal errors.
      if (isTerminal) {
        const outcome = { outcome: 'terminal', attempts: attempt, terminal: true, sideEffectCount: sideEffectCount(Object.keys(TASKS).find((n) => TASKS[n] === task)), runId, key };
        if (key !== undefined && key !== null) recordIdempotent(key, outcome);
        return outcome;
      }

      // Loop back and retry (contract: task:retry-policy-enforced).
    }
  }

  // Exhausted retries
  const exhausted = { outcome: 'exhausted', attempts: attempt, terminal: false, sideEffectCount: sideEffectCount(Object.keys(TASKS).find((n) => TASKS[n] === task)), runId, key, errorType: lastError?.type };
  if (key !== undefined && key !== null) recordIdempotent(key, exhausted);
  return exhausted;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

/**
 * Handles one HTTP request. Routes:
 *   GET  /health
 *   GET  /tasks
 *   POST /enqueue
 *   GET  /runs
 */
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'x-gateforge-env': 'task-loopback-v1' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/tasks') {
    res.writeHead(200, { 'content-type': 'application/json', 'x-gateforge-env': 'task-loopback-v1' });
    res.end(JSON.stringify({ tasks: Object.keys(TASKS) }));
    return;
  }

  if (req.method === 'GET' && path === '/runs') {
    res.writeHead(200, { 'content-type': 'application/json', 'x-gateforge-env': 'task-loopback-v1' });
    res.end(JSON.stringify({ runs: readRuns() }));
    return;
  }

  if (req.method === 'POST' && path === '/enqueue') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json', 'x-gateforge-env': 'task-loopback-v1' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }
    const { name, key, profile, payload } = parsed;
    const task = TASKS[name];
    if (!task) {
      res.writeHead(404, { 'content-type': 'application/json', 'x-gateforge-env': 'task-loopback-v1' });
      res.end(JSON.stringify({ error: `unknown task: ${name}` }));
      return;
    }
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outcome = await runTask(task, profile, payload ?? {}, key, runId);
    res.writeHead(202, { 'content-type': 'application/json', 'x-gateforge-env': 'task-loopback-v1' });
    res.end(JSON.stringify(outcome));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json', 'x-gateforge-env': 'task-loopback-v1' });
  res.end(JSON.stringify({ error: 'not found' }));
}

/**
 * Creates the example application server. Binds to `localhost` only,
 * runs tasks in-process, persists audit rows to runs.json under OS tmpdir.
 */
export function createApp() {
  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json', 'x-gateforge-env': 'task-loopback-v1' });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: { port: { type: 'string' } },
  });
  let port = 0;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`error: --port must be an integer in [1, 65535], got ${JSON.stringify(values.port)}`);
      process.exit(2);
    }
  }
  const server = createApp();
  server.listen(port, '127.0.0.1', () => {
    const { address, port: bound } = server.address();
    console.log(`gateforge pack-task example listening on http://${address}:${bound} (audit: ${RUNS_PATH})`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}