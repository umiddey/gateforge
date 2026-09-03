/** Any JSON-representable value. */
export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
/**
 * Type predicate narrowing an unknown value to {@link JsonValue}.
 * Accepts plain objects and arrays only — class instances (Date, Map,
 * custom types) are rejected even when property-less.
 */
export declare function isJsonValue(value: unknown): value is JsonValue;
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
export declare function canonicalJson(value: JsonValue): string;
/**
 * Computes the lowercase hex sha256 digest of a string or byte buffer.
 *
 * Args:
 *   input: UTF-8 text (e.g. a canonical JSON string) or raw bytes.
 *
 * Returns:
 *   string: 64-char lowercase hex digest.
 */
export declare function sha256Hex(input: string | Uint8Array): string;
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
export declare function sha256Canonical(value: JsonValue): string;
//# sourceMappingURL=canonical-json.d.ts.map