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
];
export const HttpMethodSchema = z.enum(HTTP_METHODS);
/** Which side of the join the fact came from. */
export const HttpContractRoles = ['server-route', 'frontend-call'];
export const HttpContractRoleSchema = z.enum(HttpContractRoles);
/** Source location, identical in shape to the core Location schema. */
export const HttpLocationSchema = z
    .object({
    file: z.string().min(1),
    line: z.number().int().min(1),
    col: z.number().int().min(0),
})
    .strict();
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
    /** Frontend callsite identifiers (frontend-call facts only). */
    callsites: z.array(z.string().min(1)).min(1).optional(),
    /** Where the fact was found. */
    source: HttpLocationSchema,
})
    .strict();
/** Resource kind used to carry facts through GPP/3 as evidence-only resources. */
export const HTTP_CONTRACT_KIND = 'http.contract';
/** Resource kind emitted by the endpoint compiler for joined endpoints. */
export const HTTP_ENDPOINT_KIND = 'http.endpoint';
//# sourceMappingURL=schema.js.map