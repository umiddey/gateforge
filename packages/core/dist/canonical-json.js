/**
 * GF-canonical-JSON and sha256 helpers (Interface pin #1).
 *
 * GF-canonical-JSON: UTF-8 text, object keys recursively sorted, no
 * whitespace between tokens, integers serialized plain (`1`, not `1.0`).
 * ALL gateforge hashes — fingerprints, GPP digests, witness record ids —
 * are `sha256` hex digests over the GF-canonical-JSON of the named object.
 * This is deliberately NOT RFC 8785: v1 payloads contain only strings,
 * integers, booleans, null, arrays, and objects (no floats), so the
 * canonical form is fully defined by key sorting plus JSON escaping.
 */
import { createHash } from 'node:crypto';
/**
 * Type predicate narrowing an unknown value to {@link JsonValue}.
 * Accepts plain objects and arrays only — class instances (Date, Map,
 * custom types) are rejected even when property-less.
 */
export function isJsonValue(value) {
    if (value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean') {
        return true;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    if (typeof value === 'object') {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
            return false;
        }
        return Object.values(value).every(isJsonValue);
    }
    return false;
}
/**
 * Serializes a value to its GF-canonical-JSON string form (pin #1).
 *
 * Object keys are sorted recursively (by UTF-16 code units, matching the
 * JS default string comparison). No whitespace is emitted. Integers are
 * serialized plain; non-integer finite numbers fall back to the shortest
 * round-trip decimal form (out of v1 scope, but deterministic). NaN and
 * Infinity throw — they have no canonical representation.
 *
 * Array order is preserved: arrays are ordered values, never sorted.
 *
 * Args:
 *   value: JSON-representable value to canonicalize.
 *
 * Returns:
 *   string: GF-canonical-JSON text, ready to hash or compare byte-wise.
 */
export function canonicalJson(value) {
    if (value === null)
        return 'null';
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError(`canonicalJson: ${String(value)} has no canonical JSON representation`);
        }
        return Number.isInteger(value) ? String(value) : JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const members = [];
    for (const key of keys) {
        const member = value[key];
        // An explicitly-undefined member is ABSENT for hashing purposes —
        // identical to the key not being present (JSON.stringify semantics).
        // Without this, zod-parsed artifacts carrying optional keys as
        // explicit undefined values would crash fingerprinting.
        if (member === undefined)
            continue;
        members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
    }
    return `{${members.join(',')}}`;
}
/**
 * Computes the lowercase hex sha256 digest of a string or byte buffer.
 *
 * Args:
 *   input: UTF-8 text (e.g. a canonical JSON string) or raw bytes.
 *
 * Returns:
 *   string: 64-char lowercase hex digest.
 */
export function sha256Hex(input) {
    return createHash('sha256').update(input).digest('hex');
}
/**
 * Hashes a value as GF-canonical-JSON: `sha256(canonicalJson(value))` (pin #1).
 * This is the single primitive behind fingerprints, GPP/3 digests, and
 * witness record ids.
 *
 * Args:
 *   value: JSON-representable value to hash.
 *
 * Returns:
 *   string: 64-char lowercase hex digest of the canonical form.
 */
export function sha256Canonical(value) {
    return sha256Hex(canonicalJson(value));
}
//# sourceMappingURL=canonical-json.js.map