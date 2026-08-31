import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  isJsonValue,
  sha256Canonical,
  sha256Hex,
} from '../src/index.js';

describe('GF-canonical-JSON (pin #1)', () => {
  it('sorts object keys recursively and emits no whitespace', () => {
    const value = { b: 1, a: { d: 'x', c: [2, 1] } };
    expect(canonicalJson(value)).toBe('{"a":{"c":[2,1],"d":"x"},"b":1}');
  });

  it('is key-order independent: same object, different insertion order', () => {
    const first = { resourceId: 'r', contract: 'c', policyId: 'p' };
    const second = { policyId: 'p', contract: 'c', resourceId: 'r' };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it('preserves array order (arrays are ordered values, never sorted)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([{ z: 1 }, { a: 2 }])).toBe('[{"z":1},{"a":2}]');
  });

  it('serializes integers plain and preserves string escaping', () => {
    expect(canonicalJson(1)).toBe('1');
    expect(canonicalJson(-42)).toBe('-42');
    expect(canonicalJson('quote"backslash\\newline\n')).toBe(
      '"quote\\"backslash\\\\newline\\n"',
    );
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
  });

  it('throws on NaN and Infinity (no canonical form)', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('is deterministic across repeated calls', () => {
    const value = { runId: 'r1', plugins: [{ id: 'p', version: '1' }] };
    const first = canonicalJson(value);
    const second = canonicalJson({ plugins: [{ version: '1', id: 'p' }], runId: 'r1' });
    expect(first).toBe(second);
    expect(sha256Canonical(value)).toBe(sha256Hex(second));
  });

  it('matches sha256Hex over the canonical string', () => {
    const canonical = canonicalJson({ a: 1 });
    expect(sha256Canonical({ a: 1 })).toBe(sha256Hex(canonical));
    expect(sha256Canonical({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('isJsonValue narrows correctly', () => {
    expect(isJsonValue({ a: [1, 'x', null, true] })).toBe(true);
    expect(isJsonValue({ a: () => 1 })).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
  });
});
