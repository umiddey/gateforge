/**
 * Typed outcome codes for the HTTP contract compiler (ADR 0004 D4).
 *
 * These codes are stable free-form strings, matching the existing
 * unresolved/findings convention (`no_tablename_source`,
 * `inherited_tablename_unresolved`, ...). Detectors emit them as
 * `UnresolvedReason.code` / `Finding.code`; the verdict engine uses
 * `HTTP_OBSERVATION_UNTRUSTED` as a verdict reason. They are deliberately
 * NOT a closed core enum: adding a code is additive and versioned by the
 * detector that emits it.
 */
/** A path expression the detector cannot resolve to positional shape. */
export const HTTP_PATH_DYNAMIC = 'HTTP_PATH_DYNAMIC';
/** A method expression the detector cannot resolve to a concrete verb. */
export const HTTP_METHOD_DYNAMIC = 'HTTP_METHOD_DYNAMIC';
/** A FastAPI router prefix/include prefix that is not a provable literal. */
export const FASTAPI_PREFIX_UNRESOLVED = 'FASTAPI_PREFIX_UNRESOLVED';
/** A frontend call whose target (host/URL) cannot be resolved statically. */
export const FRONTEND_CALL_TARGET_UNRESOLVED = 'FRONTEND_CALL_TARGET_UNRESOLVED';
/** A frontend call with no matching backend route. */
export const FRONTEND_ROUTE_UNWIRED = 'FRONTEND_ROUTE_UNWIRED';
/**
 * A frontend call matching more than one distinct backend route within the
 * surviving literal-precedence tier (see `join.ts`): literal matches shadow
 * parameter matches, and even after that partition the join refuses to
 * guess between distinct survivors.
 */
export const FRONTEND_ROUTE_AMBIGUOUS = 'FRONTEND_ROUTE_AMBIGUOUS';
/** An endpoint whose business semantics no positive rule could decide. */
export const ENDPOINT_SEMANTICS_UNRESOLVED = 'ENDPOINT_SEMANTICS_UNRESOLVED';
/** An endpoint that cannot be linked to exactly one business resource. */
export const ENDPOINT_RESOURCE_LINK_UNRESOLVED = 'ENDPOINT_RESOURCE_LINK_UNRESOLVED';
/**
 * Two `.gateforge/endpoints.json` capability rules match one endpoint
 * identity and assert DIFFERENT capabilities — the declarative channel
 * fails closed (no capability is applied) until the rules agree, exactly
 * like `PLANE_RULE_CONTRADICTION` on the plane channel.
 */
export const ENDPOINT_CAPABILITY_CONTRADICTION = 'ENDPOINT_CAPABILITY_CONTRADICTION';
/**
 * A runtime HTTP observation that cannot be trusted (suite-submitted
 * network record, missing run binding, wrong provenance).
 */
export const HTTP_OBSERVATION_UNTRUSTED = 'HTTP_OBSERVATION_UNTRUSTED';
/** Every typed outcome code defined by this package. */
export const HTTP_BLOCK_CODES = [
    HTTP_PATH_DYNAMIC,
    HTTP_METHOD_DYNAMIC,
    FASTAPI_PREFIX_UNRESOLVED,
    FRONTEND_CALL_TARGET_UNRESOLVED,
    FRONTEND_ROUTE_UNWIRED,
    FRONTEND_ROUTE_AMBIGUOUS,
    ENDPOINT_SEMANTICS_UNRESOLVED,
    ENDPOINT_RESOURCE_LINK_UNRESOLVED,
    ENDPOINT_CAPABILITY_CONTRADICTION,
    HTTP_OBSERVATION_UNTRUSTED,
];
//# sourceMappingURL=codes.js.map