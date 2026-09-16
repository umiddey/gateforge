/**
 * GF-canonical-JSON serialization for witness/reporter payloads.
 *
 * All hashes, state artifacts, and comparisons in the pack must go
 * through the pin-#1 canonical form. The frozen core `canonicalJson`
 * requires a compile-time `JsonValue`; wire payloads and adapter
 * responses arrive as `unknown`, so this module re-checks with the core
 * `isJsonValue` guard and renders the canonical form (or throws — a
 * non-JSON payload is a contract violation, never a silent truncation).
 */
import { isJsonValue } from '@gate-forge/core';
/** Throws unless the value is JSON-representable, then canonicalizes it. */
export declare function canonicalOf(value: unknown): string;
/** JSON-representable check for wire payloads before hashing. */
export { isJsonValue };
//# sourceMappingURL=json.d.ts.map