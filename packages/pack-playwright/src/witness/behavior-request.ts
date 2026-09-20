/**
 * Witness-owned engine-http request driver (plan 2026-09-19 §4.6, Phase 5):
 * executes one approved `request` action against the approved subject
 * origin with approved actor material. The worker never touches the
 * request — method, path, query, body, and credentials all resolve
 * engine-side from the supervisor-bound case and the trusted lease.
 *
 * Bounds (fail closed, never a hashed prefix):
 * - request/response bodies are capped (over-limit blocks);
 * - the origin must be loopback (plan invariant 5, GF-10);
 * - `multipart`/`raw` encodings and signature profiles need the
 *   Phase 6/8 drivers and block here;
 * - resolved path values cannot smuggle segments (`/` rejected).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { sha256Canonical, type JsonValue } from '@gate-forge/core';
import { assertLoopback } from './env-attestation.js';
import type { CredentialMaterial, FixtureLease } from './fixture-provider.js';

/** Proof-input bound (request and response bodies alike). */
export const BEHAVIOR_BODY_LIMIT_BYTES = 256 * 1024;

/** Typed driver failure (always a blocking diagnostic, never proof). */
export class BehaviorDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BehaviorDriverError';
  }
}

/** Approved request action shape (subset used by the Phase 5 driver). */
export interface BehaviorRequestAction {
  kind: 'request';
  method: string;
  pathTemplate: string;
  path: Record<string, { from: string; value?: unknown; key?: string }>;
  query: Record<string, { from: string; value?: unknown; key?: string }>;
  body: { encoding: string; fields?: Record<string, { from: string; value?: unknown; key?: string }>; fixture?: string };
  credentialVariant: 'valid' | 'missing' | 'corrupted';
  signatureProfile?: string;
}

/** What the driver observed (headers excluded — they carry secrets). */
export interface DrivenRequest {
  engineRequestId: string;
  method: string;
  path: string;
  query: Record<string, unknown>;
  /** Submitted body as observed (parsed JSON or form map). */
  body: unknown;
  status: number | null;
  /** Response body as observed (parsed JSON or text). */
  responseBody: unknown;
  requestDigest: string;
  responseDigest: string | null;
}

/** Unsafe fixture-key segments (no prototype-chain traversal). */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/** Resolves one InputValue against sealed lease subjects. */
function resolveValue(
  raw: { from: string; value?: unknown; key?: string },
  subjects: Record<string, unknown>,
  what: string,
): unknown {
  if (raw.from === 'literal') return raw.value ?? null;
  if (raw.from === 'fixture') {
    if (typeof raw.key !== 'string') throw new BehaviorDriverError(`${what} fixture reference has no key`);
    const segments = raw.key.split('.');
    if (segments.some((segment) => segment.length === 0 || FORBIDDEN_SEGMENTS.has(segment))) {
      throw new BehaviorDriverError(`${what} fixture key is forbidden`);
    }
    let current: unknown = subjects;
    for (const segment of segments) {
      if (typeof current !== 'object' || current === null || Array.isArray(current)) {
        throw new BehaviorDriverError(`${what} fixture key '${raw.key}' does not resolve`);
      }
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        throw new BehaviorDriverError(`${what} fixture key '${raw.key}' does not resolve`);
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current ?? null;
  }
  throw new BehaviorDriverError(`${what} uses an unsupported value source '${raw.from}'`);
}

/** Reads a bounded body from a fetch response (over-limit aborts). */
async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined || reader === null) {
    const text = await response.text();
    if (text.length > limit) throw new BehaviorDriverError('response body exceeds the proof bound');
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort cancel; the bound violation below is the verdict.
      }
      throw new BehaviorDriverError('response body exceeds the proof bound');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parses a body as JSON, falling back to raw text. */
function parseBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

export interface DriveBehaviorRequestInput {
  /** Approved request action from the bound catalog. */
  action: BehaviorRequestAction;
  /** Trusted lease (subjects + actors resolve here). */
  lease: FixtureLease;
  /** Actor profile key from the case definition. */
  actorProfile: string;
  /** Approved subject origin (the app under test; loopback only). */
  origin: string;
  /** Resolve engine-side credential material (never suite-visible). */
  resolveCredential: (credentialRef: string) => Promise<CredentialMaterial | null> | CredentialMaterial | null;
  /** Fetch timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * Drives one approved request and captures the bounded observation.
 *
 * Args:
 *   input: action, lease, actor profile, origin, credential resolver,
 *   and timeout.
 *
 * Returns:
 *   DrivenRequest: method/path/query/body/status/response plus
 *   identity digests (headers never leave the driver).
 *
 * Throws:
 *   BehaviorDriverError: unsupported encoding, unresolvable value,
 *   non-loopback origin, timeout, over-limit body, or transport
 *   failure — always a blocking diagnostic, never proof.
 */
export async function driveBehaviorRequest(input: DriveBehaviorRequestInput): Promise<DrivenRequest> {
  const { action, lease } = input;
  if (action.signatureProfile !== undefined && action.signatureProfile !== 'hmac-sha256') {
    throw new BehaviorDriverError(`unsupported signature profile '${action.signatureProfile}'`);
  }
  if (action.body.encoding === 'multipart') {
    throw new BehaviorDriverError(`'multipart' bodies need the Phase 6 file driver`);
  }
  if (action.body.encoding === 'raw' && action.signatureProfile === undefined) {
    throw new BehaviorDriverError(`'raw' bodies require an engine-side signature profile`);
  }
  await assertLoopback(input.origin, 'behavior principal').catch((error: unknown) => {
    throw new BehaviorDriverError(error instanceof Error ? error.message : String(error));
  });
  const base = input.origin.replace(/\/+$/, '');

  // Concrete path: every template variable resolves to a segment-safe value.
  const templateSegments = action.pathTemplate.split('/');
  const concreteSegments: string[] = [];
  for (const segment of templateSegments) {
    const match = /^\{([A-Za-z0-9_]+)\}$/.exec(segment);
    if (match === null) {
      concreteSegments.push(segment);
      continue;
    }
    const name = match[1] as string;
    const raw = action.path[name];
    if (raw === undefined) throw new BehaviorDriverError(`path parameter '${name}' is not declared`);
    const resolved = resolveValue(raw, lease.subjects, `path parameter '${name}'`);
    if (typeof resolved !== 'string' && typeof resolved !== 'number') {
      throw new BehaviorDriverError(`path parameter '${name}' is not a scalar`);
    }
    const text = String(resolved);
    if (text.length === 0 || text.includes('/')) {
      throw new BehaviorDriverError(`path parameter '${name}' would smuggle path segments`);
    }
    concreteSegments.push(encodeURIComponent(text));
  }
  const path = concreteSegments.join('/').replace(/\/+/g, '/');

  // Declared query, resolved exactly (the driver sends the contract).
  const query: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(action.query)) {
    const resolved = resolveValue(raw, lease.subjects, `query parameter '${name}'`);
    if (typeof resolved !== 'string' && typeof resolved !== 'number' && typeof resolved !== 'boolean') {
      throw new BehaviorDriverError(`query parameter '${name}' is not a scalar`);
    }
    query[name] = resolved;
  }
  const queryText = Object.entries(query)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    .join('&');

  // Declared body, resolved exactly. `raw` resolves the fixture-named
  // EXACT bytes from the trusted lease subjects — the signature (when a
  // profile is declared) is computed engine-side over those exact bytes,
  // never over a re-serialization.
  let bodyFields: Record<string, unknown> = {};
  let bodyText: string;
  let contentType: string;
  if (action.body.encoding === 'raw') {
    const fixtureName = (action.body as { fixture?: unknown }).fixture;
    if (typeof fixtureName !== 'string') throw new BehaviorDriverError('raw body has no fixture reference');
    const resolved = resolveValue({ from: 'fixture', key: fixtureName }, lease.subjects, 'raw body fixture');
    if (typeof resolved !== 'string') throw new BehaviorDriverError('raw body fixture is not exact bytes (string)');
    bodyText = resolved;
    contentType = 'application/json';
  } else {
    for (const [name, raw] of Object.entries(action.body.fields ?? {})) {
      bodyFields[name] = resolveValue(raw, lease.subjects, `body field '${name}'`);
    }
    if (action.body.encoding === 'json') {
      bodyText = JSON.stringify(bodyFields);
      contentType = 'application/json';
    } else {
      bodyText = new URLSearchParams(
        Object.entries(bodyFields).map(
          ([name, value]): [string, string] => [name, typeof value === 'string' ? value : JSON.stringify(value)],
        ),
      ).toString();
      contentType = 'application/x-www-form-urlencoded';
    }
  }
  if (bodyText.length > BEHAVIOR_BODY_LIMIT_BYTES) {
    throw new BehaviorDriverError('request body exceeds the proof bound');
  }

  // Actor material resolves privately, engine-side only.
  const headers: Record<string, string> = { 'content-type': contentType };
  const actor = lease.actors[input.actorProfile];
  if (actor === undefined) {
    throw new BehaviorDriverError(`actor profile '${input.actorProfile}' has no lease`);
  }
  if (input.action.credentialVariant === 'valid' || input.action.credentialVariant === 'corrupted') {
    const material = await input.resolveCredential(actor.credentialRef);
    if (material === null) throw new BehaviorDriverError('actor credential reference does not resolve');
    if (input.action.credentialVariant === 'valid') {
      for (const [name, value] of Object.entries(material.headers)) {
        // The signing secret is consumed by the driver (never sent as a
        // header); the signature is computed over the exact raw bytes.
        if (name === 'x-gateforge-signing-secret') continue;
        headers[name] = value;
      }
      if (action.signatureProfile === 'hmac-sha256') {
        const secret = material.headers['x-gateforge-signing-secret'];
        if (secret === undefined) throw new BehaviorDriverError('signing profile declared but no engine-side secret is bound');
        headers['x-signature'] = createHmac('sha256', secret).update(bodyText, 'utf8').digest('hex');
        headers['x-webhook-timestamp'] = String(Date.now());
        headers['x-webhook-attempt'] = '1';
      }
    } else {
      for (const [name, value] of Object.entries(material.headers)) {
        if (name === 'x-gateforge-signing-secret') continue;
        headers[name] = value.length > 0 ? `${value.slice(0, -1)}X` : 'X';
      }
    }
  }

  const engineRequestId = randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${base}${path}${queryText.length > 0 ? `?${queryText}` : ''}`, {
      method: action.method.toUpperCase(),
      headers,
      body: action.method.toUpperCase() === 'GET' || action.method.toUpperCase() === 'HEAD' ? undefined : bodyText,
      signal: controller.signal,
      // Never follow redirects: the observed status is the principal's
      // own response (a form POST legitimately answers 303).
      redirect: 'manual',
    });
  } catch (error) {
    throw new BehaviorDriverError(
      `principal request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  const responseText = await readBoundedBody(response, BEHAVIOR_BODY_LIMIT_BYTES);
  const responseBody = parseBody(responseText);
  const bodyValue =
    action.body.encoding === 'raw'
      ? bodyText
      : action.body.encoding === 'json'
        ? (parseBody(bodyText) as unknown)
        : Object.fromEntries(new URLSearchParams(bodyText).entries());
  const requestDigest = sha256Canonical({
    method: action.method.toUpperCase(),
    path,
    query,
    body: bodyValue,
  } as JsonValue);
  const responseDigest = sha256Canonical({ status: response.status, body: responseBody } as JsonValue);
  return {
    engineRequestId,
    method: action.method.toUpperCase(),
    path,
    query,
    body: bodyValue,
    status: response.status,
    responseBody,
    requestDigest,
    responseDigest,
  };
}
