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
export declare const HTTP_CONTRACT_SCHEMA_VERSION = 1;
/** Schema version field with the same strictness rules as core. */
export declare const HttpContractSchemaVersionField: z.ZodLiteral<1>;
/** Concrete HTTP methods a fact may declare. `ANY` is exposure-only. */
export declare const HTTP_METHODS: readonly ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "ANY"];
export declare const HttpMethodSchema: z.ZodEnum<{
    GET: "GET";
    HEAD: "HEAD";
    POST: "POST";
    PUT: "PUT";
    PATCH: "PATCH";
    DELETE: "DELETE";
    OPTIONS: "OPTIONS";
    ANY: "ANY";
}>;
export type HttpMethod = (typeof HTTP_METHODS)[number];
/** Which side of the join the fact came from. */
export declare const HttpContractRoles: readonly ["server-route", "frontend-call"];
export declare const HttpContractRoleSchema: z.ZodEnum<{
    "server-route": "server-route";
    "frontend-call": "frontend-call";
}>;
export type HttpContractRole = (typeof HttpContractRoles)[number];
/** Source location, identical in shape to the core Location schema. */
export declare const HttpLocationSchema: z.ZodObject<{
    file: z.ZodString;
    line: z.ZodNumber;
    col: z.ZodNumber;
}, z.core.$strict>;
export type HttpLocation = z.infer<typeof HttpLocationSchema>;
/**
 * One discovered HTTP surface. Strict: unknown fields are rejected so a
 * detector cannot smuggle unversioned payloads through the join.
 */
export declare const HttpContractFactSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    role: z.ZodEnum<{
        "server-route": "server-route";
        "frontend-call": "frontend-call";
    }>;
    method: z.ZodEnum<{
        GET: "GET";
        HEAD: "HEAD";
        POST: "POST";
        PUT: "PUT";
        PATCH: "PATCH";
        DELETE: "DELETE";
        OPTIONS: "OPTIONS";
        ANY: "ANY";
    }>;
    normalizedPath: z.ZodString;
    rawPath: z.ZodString;
    framework: z.ZodString;
    handlerSymbol: z.ZodOptional<z.ZodString>;
    requestSchemaSymbols: z.ZodOptional<z.ZodArray<z.ZodString>>;
    responseSchemaSymbols: z.ZodOptional<z.ZodArray<z.ZodString>>;
    callsites: z.ZodOptional<z.ZodArray<z.ZodString>>;
    source: z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strict>;
export type HttpContractFact = z.infer<typeof HttpContractFactSchema>;
/** Resource kind used to carry facts through GPP/3 as evidence-only resources. */
export declare const HTTP_CONTRACT_KIND = "http.contract";
/** Resource kind emitted by the endpoint compiler for joined endpoints. */
export declare const HTTP_ENDPOINT_KIND = "http.endpoint";
//# sourceMappingURL=schema.d.ts.map