/**
 * Canonical HTTP contract facts (ADR 0004 D1).
 *
 * A contract fact is one discovered HTTP surface: either a backend server
 * route or a frontend API-client call. Facts are evidence, never decisions:
 * consumption relationships exist only after the deterministic join (D3)
 * runs, and endpoint semantics are decided exclusively by the classifier
 * over linked facts.
 *
 * The zod schemas here are the normative definitions; detectors serialize
 * facts as GPP/3 resources of kind `http.contract` whose attributes carry
 * this payload (open attribute record, so the wire shape stays compatible).
 */
import { z } from 'zod';

/** Wire schema version for the fact payload. */
export const HTTP_CONTRACT_SCHEMA_VERSION = 1;

/** Schema version field with the same strictness rules as core. */
export const HttpContractSchemaVersionField = z.literal(1, {
  error: 'http contract schemaVersion must be exactly 1',
});

/** Concrete HTTP methods a fact may declare. `ANY` is exposure-only. */
export const HTTP_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'ANY',
] as const;

export const HttpMethodSchema = z.enum(HTTP_METHODS);
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Which side of the join the fact came from. */
export const HttpContractRoles = ['server-route', 'frontend-call'] as const;
export const HttpContractRoleSchema = z.enum(HttpContractRoles);
export type HttpContractRole = (typeof HttpContractRoles)[number];

/** Source location, identical in shape to the core Location schema. */
export const HttpLocationSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().min(1),
    col: z.number().int().min(0),
  })
  .strict();
export type HttpLocation = z.infer<typeof HttpLocationSchema>;

/**
 * One field a frontend call site reads off a call's response: the field
 * name exactly as the code writes it, and where that read happens. Pure
 * evidence — the fact never decides anything on its own.
 */
export const ResponseReadSchema = z
  .object({
    field: z.string().min(1),
    location: HttpLocationSchema,
    /**
     * Index of the `||` / `??` fallback chain this operand belongs to, in
     * source order within the call; absent for a read that stands alone.
     * The operands of one chain are ONE decision about ONE result, so the
     * response-model check judges them together: when a chain reads a
     * declared field, its other operands are the defensive fallbacks and
     * no field is missing.
     */
    chain: z.number().int().min(0).optional(),
  })
  .strict();
export type ResponseRead = z.infer<typeof ResponseReadSchema>;

/**
 * One discovered HTTP surface. Strict: unknown fields are rejected so a
 * detector cannot smuggle unversioned payloads through the join.
 */
export const HttpContractFactSchema = z
  .object({
    schemaVersion: HttpContractSchemaVersionField,
    role: HttpContractRoleSchema,
    method: HttpMethodSchema,
    /** Canonical positional path (ADR 0004 D2), e.g. `/api/v1/accounts/{}`. */
    normalizedPath: z.string().min(1),
    /** Exactly as written in source, before canonicalization. */
    rawPath: z.string().min(1),
    /** Producing framework/client id, e.g. `fastapi`, `fetch`, `axios`. */
    framework: z.string().min(1),
    /** Backend handler symbol (server-route facts only). */
    handlerSymbol: z.string().min(1).optional(),
    /** Request body/query/dependency schema symbols (server-route facts). */
    requestSchemaSymbols: z.array(z.string().min(1)).min(1).optional(),
    /** Response model symbols (server-route facts). */
    responseSchemaSymbols: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Wire names the route's response model answers to (plan 2026-09-25
     * Phase 4b item 5): every pydantic field name plus every declared
     * alias, in declaration order. Present ONLY when the detector proved
     * a concrete model — an unknown/Any/dict model, an unresolvable
     * symbol, or a model with an unprovable base stays absent, never a
     * partial list. A frontend read with no entry here is exactly the
     * dropped-field drift `RESPONSE_FIELD_MISSING_FROM_MODEL` reports.
     */
    responseModelFields: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Fields the call site reads off this call's response, each with the
     * location of the read (plan 2026-09-25 Phase 4b item 5). Bounded
     * static reads of the detected call's own result — `.data.<field>`
     * and destructuring of the awaited result or its payload — within the
     * enclosing function, same file, never inferred across files.
     */
    responseReads: z.array(ResponseReadSchema).min(1).optional(),
    /** Frontend callsite identifiers (frontend-call facts only). */
    callsites: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Static registration position of a server route (0.14): the route's
     * index in the app's flattened registration sequence — Starlette (and
     * therefore FastAPI) matches routes in REGISTRATION order, each
     * router's routes copying at its `include_router` call, depth-first
     * in call order, decorator source order within one router. `scope`
     * names the serving app (uvicorn-style `module:var`); `order` is the
     * 0-based position in that app's flattened sequence. Present ONLY
     * when the detector can prove the position statically — a route
     * appended to its router after an include call, declared inside a
     * function body, reachable from more than one scope, or mounted
     * through a call-time (registry-function) include stays ABSENT, and
     * registration-order attribution treats the inventory as unprovable
     * (fail closed).
     */
    registration: z
      .object({
        scope: z.string().min(1),
        order: z.number().int().min(0),
      })
      .strict()
      .optional(),
    /**
     * The route's raw path string carries a typed convertor
     * (`{id:int}`, `{id:uuid}`, `{p:path}` — never the plain `{name}`
     * `str` convertor): the route matches NARROWER than its canonical
     * single-slot shape suggests, so registration-order attribution
     * treats it as positionally uncertain. Present only as `true` —
     * absent means "plain, matches its whole slot".
     */
    typedPathParams: z.literal(true).optional(),
    /**
     * The detector's MOUNT PROOF for this route (plan finding 13/13c):
     * the include chain that reaches it, `include-chain:<app> → <router>
     * → …` in the same `<module>:<var>` identity {@link registration}'s
     * `scope` uses. ABSENT when no include edge mounts the route's
     * router — the detector still reports the route (a declaration is a
     * claim) but proves nothing serves it, which is what lets the
     * coverage rules subtract it from the served denominator instead of
     * counting dead code as served. A detector that cannot follow the
     * mount graph emits no proof anywhere in the run, and the rules
     * treat every route as served (unknown, never refuted).
     */
    mountProvenance: z.string().min(1).optional(),
    /**
     * The route's declaration sits inside a conditional block (a
     * module-level `if`, `try`, `with`, `for` or `while`), so it
     * registers only when that branch runs and its served-ness is
     * unknown statically (plan finding 13b). Present only as `true` —
     * absent means "declared unconditionally". It is NOT a served-ness
     * input: the route's router is mounted either way, so the route
     * keeps its {@link mountProvenance} and its {@link registration}.
     */
    conditional: z.literal(true).optional(),
    /** Where the fact was found. */
    source: HttpLocationSchema,
  })
  .strict();

export type HttpContractFact = z.infer<typeof HttpContractFactSchema>;

/** Resource kind used to carry facts through GPP/3 as evidence-only resources. */
export const HTTP_CONTRACT_KIND = 'http.contract';

/** Resource kind emitted by the endpoint compiler for joined endpoints. */
export const HTTP_ENDPOINT_KIND = 'http.endpoint';
