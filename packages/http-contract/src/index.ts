/**
 * `@gate-forge/http-contract` — framework-neutral canonical HTTP contract
 * (ADR 0004): strict fact schemas, typed outcome codes, path/method
 * normalization, and the deterministic frontend-call/server-route join.
 *
 * This package is deliberately narrow: no framework parsing (detectors own
 * that), no classification (core owns that), no I/O. Everything is a pure
 * function so identical inputs produce byte-identical outputs.
 */
export {
  mergeRouteSources,
  routeTableFromOpenApi,
  type MergedRouteSources,
  type OpenApiRoute,
  type RouteSourceMismatch,
  type RouteSourceMode,
  type RouteTableEntry,
} from './route-table.js';
export {
  FASTAPI_PREFIX_UNRESOLVED,
  FRONTEND_CALL_TARGET_UNRESOLVED,
  FRONTEND_ROUTE_AMBIGUOUS,
  FRONTEND_ROUTE_UNWIRED,
  ENDPOINT_CAPABILITY_CONTRADICTION,
  ENDPOINT_RESOURCE_LINK_UNRESOLVED,
  ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED,
  ENDPOINT_SEMANTICS_UNRESOLVED,
  HTTP_METHOD_DYNAMIC,
  HTTP_OBSERVATION_UNTRUSTED,
  HTTP_PATH_DYNAMIC,
  HTTP_ENDPOINT_UNMOUNTED,
  HTTP_BLOCK_CODES,
  type HttpBlockCode,
} from './codes.js';
export {
  HTTP_CONTRACT_SCHEMA_VERSION,
  HTTP_CONTRACT_KIND,
  HTTP_ENDPOINT_KIND,
  HTTP_METHODS,
  HttpContractFactSchema,
  HttpContractRoleSchema,
  HttpContractSchemaVersionField,
  HttpLocationSchema,
  HttpMethodSchema,
  ResponseReadSchema,
  type HttpContractFact,
  type HttpContractRole,
  type HttpLocation,
  type HttpMethod,
  type ResponseRead,
} from './schema.js';
export {
  HTTP_CONTRACT_VERSION,
} from './version.js';
export {
  HTTP_PARAM_SLOT,
  HTTP_WILDCARD_SLOT,
  normalizeHttpMethod,
  normalizeHttpPath,
  pathSegments,
  type NormalizePathDynamic,
  type NormalizePathOk,
  type NormalizePathOptions,
  type NormalizePathResult,
} from './normalize.js';
export {
  canonicalEndpointIdentity,
  endpointResourceName,
  joinFrontendCalls,
  routeMatchKind,
  routeMatchesCall,
  type EndpointIdentity,
  type JoinBlock,
  type JoinedEndpoint,
  type JoinResult,
  type RouteMatchKind,
} from './join.js';
export { derivePathResourceName } from './linkage.js';
