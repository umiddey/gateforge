/**
 * The validation pack's obligation contract vocabulary.
 *
 *   - validation:boundary-accepted       — a request whose payload sits
 *     inside every constraint (min/max/regex/enum) is accepted (2xx).
 *   - validation:boundary-rejected       — a request whose payload
 *     violates at least one constraint is rejected (4xx) with an
 *     explicit error message naming the failing field.
 *   - validation:no-side-effect-on-reject — a rejected request produces
 *     NO persistence side effect (a post-reject GET shows the row
 *     count unchanged).
 *   - validation:error-message-explicit  — the rejection response
 *     names the field that violated the contract (not a generic 400).
 *
 *   - validation:envelope-shape-stable   — the request schema is
 *     versioned and a single re-declared schema change does not
 *     silently mutate the contract (caller must re-classify).
 */
export const VALIDATION_OBLIGATIONS = [
    'validation:boundary-accepted',
    'validation:boundary-rejected',
    'validation:no-side-effect-on-reject',
    'validation:error-message-explicit',
    'validation:envelope-shape-stable',
];
//# sourceMappingURL=obligations.js.map