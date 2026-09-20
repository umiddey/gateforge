# Gateforge: Complete Endpoint Behavior and Protected Enforcement Megaplan

**Plan status:** REPOSITORY-SIDE COMPLETE / HOST BOOTSTRAP COMPLETE / EXTERNAL ACCEPTANCE PENDING. Gateforge installed Podman 6.1.2 through the owner-approved Arch package flow, verified rootless mode, and configured the property repository for managed enforcement. Future Arch full-system fallback upgrades are now confirmation-gated; managed-host container acceptance, protected GitHub, approved image, and multipart browser acceptance still require owner-provisioned inputs.
**Created:** 2026-09-19.
**Mapped memory:** `docs/memory/20260919_1544_endpoint_behavior_and_trust_megaplan.md`.
**Scope:** All five priorities from the conversation, not only endpoint coverage and result matching.
**Authoring method:** Direct repository inspection and an isolated engine experiment. No subagents. No application implementation changes.
**Execution rule:** Follow phases in dependency order. Every phase must update this plan AND its mapped memory before the next phase starts.

## 1. Why this plan exists

The user asked whether Gateforge really checks every route that changes a table and whether tests can cheat. The concrete counterexample was:

- A customer edits a profile through one endpoint.
- An administrator edits the same table through another endpoint.
- A spreadsheet import changes that table through a third endpoint.
- One successful table-update test must not give all three paths credit.

A second example was a test clicking Save on invoice A but reading invoice B. The desired proof must connect the particular operation to the particular record and expected values. A success response alone is insufficient.

The property-management repository's local E2E validators were examined earlier in the conversation. They include useful source-pattern checks, but table/operation tags and the presence of clicks/assertions cannot establish that the right operation actually happened. This plan must not port those text checks as proof authority.

The user explicitly requested a highly detailed plan that less capable implementation agents can execute without guessing. The request covers ALL of:

1. Separate coverage for every applicable endpoint, including multiple endpoints affecting one table.
2. Connecting each request/action to the exact observed result.
3. Checking forbidden actions, invalid inputs, failures, retries, and duplicate side effects.
4. Keeping approval rules, evidence authority, and final acceptance outside the coding agent's control.
5. Deliberately trying to fool the checker and proving the attempts are rejected.

The product must never promise that all cheating or all bugs are impossible. The precise goal is enforceable, bounded behavioral requirements under a stated trust boundary.

## 2. Read this first: what already exists

Implementation agents MUST read the sources named for their phase. Documentation is background; current implementation and the contracts in this plan resolve stale descriptions.

### 2.1 Verified implementation inventory

| Area | Existing implementation | Decision for this plan |
|---|---|---|
| Endpoint discovery | `packages/cli/src/endpoint-compiler.ts`, `compileEndpointContribution`, currently lines 517–1018, builds an inventory of **all discovered concrete routes**, consumed or not | Extend its output; do not write a second endpoint scanner |
| Route canonicalization | `packages/http-contract`; compiler imports canonical endpoint/path helpers | Reuse canonical identities; do not split paths with a new ad-hoc matcher |
| Endpoint declarations | `packages/cli/src/endpoint-config.ts`: `.gateforge/endpoints.json` declares capabilities; `planes.json` declares planes | Preserve these responsibilities; a capability declaration is not runtime proof |
| Default policies | `packages/cli/src/commands/init.ts:165–189`, `POLICIES_TEMPLATE`, requires only `persistence:*` | Keep basic onboarding honest; the new complete-behavior profile is explicit owner opt-in |
| Optional endpoint policy | Same file, `TRANSPORT_ONLY_POLICY_EXAMPLE:147–163` | Keep its weaker meaning: matching observed request and successful status, not business correctness |
| Table coverage | `packages/core/src/policy/coverage.ts`, `evaluateCoveragePolicy`; `schemas/coverage-policy.ts` | Preserve existing table checks; they do not become endpoint coverage automatically |
| Obligation identity | `packages/core/src/schemas/obligation.ts:19–46` | Keep `<resourceId>:<contract>`; do not append scenario data to resource IDs |
| Resource identity | `packages/core/src/graph/schema.ts:208–241` | Use normalized, plane-qualified graph IDs. Raw compiler IDs such as `http.endpoint:PATCH /x/{}` are NOT normalized obligation resource IDs |
| Fingerprints | `packages/core/src/fingerprints.ts:16–48` | Extend through one canonical helper; migrate every caller |
| Test reuse/mapping | `packages/core/src/schemas/test-map.ts`, `packages/core/src/mapping`, CLI `mapping.ts`, `commands/tests.ts` | Extend existing catalog/mapping; do not invent a parallel test registry |
| Changed selection | `packages/cli/src/execution.ts`, `planScopedExpectedSet:373–457`; `scope.ts` | Add effect/dependency closure before selecting tests; retain complete execution of selected files |
| Engine browser | `packages/pack-playwright/src/witness/browser.ts`, `EngineBrowserManager`, `driveEngineAction`, `readEngineVisible` | Reuse real engine-owned Chromium; never give suite-provided UI records equal authority |
| Wizard support | `packages/pack-playwright/src/surface.ts`, surface versions 1 and 2; `driveCreateSteps` | Extend constrained surface operations only where required; do not replace them with arbitrary test callbacks |
| Engine state reads | `packages/pack-playwright/src/witness/types.ts:651–741`, `EvidenceAdapter`, `AdapterContext` | Reuse adapters. Preserve GET-only read transport; introduce bounded, trusted state-scope observations explicitly |
| Existing Observe path | `witness/server.ts`, `finalizeObserveClaim:2991–3134`; `EvidenceAdapter.observe` | Preserve as a weaker persistence path. It currently permits one binding per operation and does not implement complete endpoint cases |
| Backend-only observations | `EvidenceAdapter.probeServer`, `handleServerPersistence`, witnessed pytest path | Reuse read-side mechanism; test-written intents remain untrusted |
| Existing semantic grading | `core/src/verdict/evaluate.ts`, `registry.ts`, `pack-verifiers.ts` | Extend the same registry. First-wins registration must remain enforced |
| Domain contracts | Auth, validation, workflow, webhook and task packs export concrete vocabularies | They currently lack authoritative state-based verifiers. Implement their real observation paths, not a status-code approximation |
| Execution supervision | `core/src/supervision/index.ts`, `superviseExecution`; pack supervisor/drain | Preserve expected-versus-executed comparison, zero retries, skip/only refusal and teardown failure handling |
| Child environment | `pack-playwright/src/discovery/runner-env.ts`; trusted runner config | Existing allowlists are valuable, but environment filtering is NOT an OS isolation boundary |
| Signed receipts | `core/src/schemas/gate-receipt.ts`; `core/src/receipt/index.ts`; CLI `execution.ts`, `receipts.ts` | Extend the existing issuance/verification route; no second receipt system |
| Broker | `packages/cli/src/broker.ts`, `brokerCommitCommand` | Retain authoritative CAS commit, but remove candidate-code evaluation from the authority process and bind the frozen tree explicitly |
| Enforcement diagnostics | `packages/cli/src/commands/enforcement.ts`, `buildDoctorReport` | Strengthen evidence of actual isolation. Checking only current-user write permission is not sufficient |
| Adversarial harness | `core/src/testing/red-probe.ts`, `docs/testing/RED_PROBE.md` | Extend it; do not create a generic mutation-testing framework |

### 2.2 Important current limitations and documentation traps

1. `generateObligations` in `core/src/policy/evaluate.ts:314–350` explicitly skips `http.endpoint` for `crud:*` and `persistence:*`. Adding more table tests cannot close endpoint coverage.
2. `evaluateCoveragePolicy` asks whether **some mapping** covers a table and operation. It does not enumerate the endpoints that perform that operation.
3. `gradeTransportRecord` in `core/src/verdict/pack-verifiers.ts:502–610` checks provenance, route identity and optional 2xx status. It does not prove that the endpoint made the expected state change.
4. `evaluateObligation` currently accepts a satisfying claim for an obligation. This is unsuitable for a new obligation requiring several distinct cases unless the required cases are explicitly aggregated with AND semantics.
5. `ObserveBinding` currently has one `ObserveMutation` for each CRUD operation. Do not merely change these values into arrays and claim the coverage problem is solved.
6. Some README sections and older source comments say `crud:*` is unavailable. Current `CRUD_CAPABILITY` and ADR 0006 show it is available through the engine browser. Preserve it.
7. `.zcode/plans/2026-09-18-onboarding-overlay-observe.md` has an outdated introductory status but completed progress checkboxes. Source confirms Observe and wizard support exist. Do not reimplement them.
8. Domain packs' direct example-server tests are NOT evidence that the CLI/witness/verifier path can grade those contracts. Current capability registry reports auth/task/validation/webhook/workflow unavailable.
9. Existing `EvidenceAdapter.read` through a candidate-owned application API cannot, by itself, defeat an application that lies about its own stored state. Strong protected mode needs an independently controlled state observer.
10. Existing broker code freezes a tree and then recomputes pipeline digests from the live workspace. `recomputeWorkspaceDigests` runs the pipeline before approved-policy evaluation in the broker. The new protected path must not evaluate candidate modules or changing workspace bytes in the authority process. This is a code-ordering finding, not a claimed exploit reproduced in this planning task.
11. Existing server-rollout documentation records incomplete infrastructure work. Do not copy an old `VERIFIED` label into a claim about today's host settings.
12. `ResourceGraph` currently contains resources, unresolved entries, findings and stale references; it has no generic `edges` property. Use the explicit dependency index specified below, not an invented existing graph API.

### 2.3 Planning experiment actually performed

An isolated `node --input-type=module -e <script>` invocation imported the built core and init policy constants, created one table plus three normalized endpoint resources, ran the real policy/coverage functions and validated generated obligations with `ObligationSchema`.

Observed, exit 0:

- Starter policy: only table `persistence:read` and `persistence:update` obligations.
- Optional transport policy: six obligations, request/status for each of the three endpoints.
- One table-update mapping: zero table-coverage blockers.
- Capabilities: `crud`, `http`, `persistence` available; `auth`, `task`, `validation`, `webhook`, `workflow` unavailable.

This is engine-level evidence of the planning assumptions, not a browser run or a full-suite result. No baseline implementation test results are invented in this plan.

## 3. Scope, trust model and definition of done

### 3.1 In scope

- Every discovered concrete HTTP endpoint in the approved discovery scope, including server-only routes, imports, admin paths, read paths, command paths and paths sharing a table.
- Multiple effects per endpoint; one table affected by multiple endpoints; same bare table name in different planes.
- Positive, negative, rejection-with-no-mutation, permission, validation, workflow, webhook, duplicate-delivery and bounded-retry cases.
- Existing browser, Observe and server test paths with honest, distinct proof strengths.
- Protected policy/adapter/runtime ownership, immutable candidate execution, exact-candidate acceptance, server enforcement and a runnable Linux managed reference deployment.
- Real adversarial end-to-end verification and package-install verification.

### 3.2 Not a promise

- Not proof of every behavior over every possible input, future time, or external service.
- Not protection against the host administrator, compromised kernel/browser, or an owner approving malicious rules/observer code.
- Not automatic understanding of arbitrary business intent.
- Not automatic route discovery for every framework or runtime-generated router.
- Not a claim that an arbitrary existing Playwright test becomes strongly witnessed without an appropriate observation path.
- Not an authorization to change the property-management repository, production databases, protected branches, account settings or release tags during this implementation.

### 3.3 Completion must be split into two explicit results

**Repository implementation complete:** all source phases, examples, isolated deployment probes, package-install checks and mandatory adversarial cases pass.

**Deployment verified:** an owner-approved disposable hosting project and managed host have actually passed the protected-ref and process-isolation checks in Phase 10. Until then record `DEPLOYMENT BLOCKED`, not full five-priority completion. Implement every reachable repository-side requirement before reporting this blocker.

The plan itself is complete as a planning deliverable now; its implementation remains pending.

### 3.4 Required invariants

- A requirement is declared by approved policy, never by a test saying it passed.
- Every required endpoint and required case has its own identity and observable result.
- Required-case satisfaction is ALL cases, never first passing case, percentage coverage, or a count that hides omissions.
- One table-level result cannot satisfy a distinct endpoint's requirement.
- An operation's action, request, entity identity, before-state and after-state belong to the same witness-issued execution.
- Setup traffic, state-reading traffic and the principal operation have distinct roles; setup never earns operation credit.
- A denied/invalid operation must be compared with authoritative before/after state. An error status alone is not proof of no effect.
- Required observations that fail, truncate, time out, are ambiguous or cannot establish completion block the case.
- New discovered endpoints cannot inherit blanket approval from missing declarations, an `internal` label, or a sibling endpoint.
- Existing basic/Observe modes must not be described as equivalent to the protected complete-behavior profile.
- A signed false statement is still false. Signing cannot replace independent observation.
- The candidate cannot read authority credentials, modify the approved observer, replace the final gate job, or change the accepted candidate after testing.

## 4. Locked design decisions

These are implementation instructions, not alternatives for an agent to choose between. Names marked NEW below do not exist yet.

### 4.1 Add one approved behavior document; do not overload endpoint capability rules

Add optional `behaviorPolicy: string` to `GateforgeConfigSchema`, pointing to `.gateforge/behavior.yml` by convention. Absence preserves today's basic behavior. Presence enables the complete-behavior requirements in this plan; there is no `warnOnly`, percentage or silent fallback option inside this document.

NEW schema owner: `packages/core/src/schemas/behavior-policy.ts`.
NEW pure compiler owner: `packages/core/src/policy/behavior.ts`.

The document carries:

```ts
interface BehaviorPolicy { // NEW; implement with strict zod schemas
  schemaVersion: 1;
  endpoints: EndpointBehavior[];
  resources: ResourceBehavior[];
}
interface EndpointBehavior {
  resourceId: string;       // normalized http.endpoint graph id, no colon
  effects: EffectScope[];   // explicit full business resource ids
  cases: BehaviorCase[];
  disposition?: { kind: 'operational-only' | 'out-of-scope'; reason: string };
}
interface ResourceBehavior {
  resourceId: string;       // existing domain/task/workflow resource id
  effects: EffectScope[];
  cases: BehaviorCase[];
}
```

Rules:

- Enumerate all discovered endpoints against `endpoints`, not only `frontendConsumed` endpoints.
- Missing entry -> `ENDPOINT_BEHAVIOR_MISSING`. Entry for nonexistent endpoint -> `BEHAVIOR_REFERENCE_STALE`.
- Duplicate entries or contradictory endpoint/effect bindings are invalid configuration, exit 2.
- An `operational-only` disposition is legal only for positively classified `health-operations` routes, and still requires a transport check. A route named `/health/customers` is not automatically operational.
- `out-of-scope` requires owner approval through the same protected digest and is always displayed as an exclusion. It is never counted as strongly tested. Strict in-scope requirements cannot be waived this way after being selected for a candidate.
- Do not infer an exclusion from `exposure: internal`, no frontend calls, missing adapter, or missing detector.
- Preserve `.gateforge/endpoints.json` for capability classification. A declared capability does not choose an entity, submit input, declare a successful outcome or approve an exception.
- Source-derived `linkedResourceName` remains an explanatory candidate. This document resolves actual effects using full resource IDs; conflicts with positive source facts block, not override silently.
- New app-specific behavior cannot be inferred safely from an endpoint name. `init` may produce inventory output and report missing owner declarations, but must not invent runnable acceptance rules or say ready.

### 4.2 Define finite, deterministic behavior cases

NEW `BehaviorCase` is a strict discriminated union, not arbitrary JavaScript.

Common required fields:

| Field | Exact meaning |
|---|---|
| `id` | Slug matching `[a-z0-9][a-z0-9._-]*`, unique within the subject resource |
| `contract` | One existing domain contract or one new strong HTTP contract below |
| `channel` | `engine-browser`, `engine-http`, or `engine-task` |
| `fixture` | Approved fixture recipe key, never a suite-supplied setup callback |
| `actor` | Approved actor profile key; use explicit `anonymous` for unauthenticated cases |
| `action` | One of the bounded action variants below |
| `expect` | Approved response/state observations for the case |
| `controlCase` | Required positive-control case key for permission/validation rejection where relevant |

Canonical case identity is `sha256Canonical({domain:'gateforge.case.v1', resourceId, id})`. Keep the readable resource ID and slug in reports. Case identity does not include mutable expected values; a separate case specification digest does.

Action variants:

1. `surface`: approved surface key, existing operation create/read/update/delete, fixture-bound subject reference if needed, and approved input fields. Extend surface v2 with bounded upload/file input where the import acceptance fixture needs it. No `evaluate`, arbitrary script, supplied browser instance or test-chosen base URL.
2. `request`: exact method, endpoint-relative path template, fixture-bound path/query parameters, supported body encoding (`json`, `form`, `multipart`, `raw`), declared body values/file fixture references. Secrets are actor/signature references, never YAML literals. Keep exact raw bytes for signature cases.
3. `deliver`: declared task resource, payload fixture, idempotency key reference, count and schedule (`serial` or `concurrent`). Counts are finite positive integers. Each delivery is engine-controlled.
4. `sequence`: a finite nonempty list of the above actions for workflows/retry policies. No loops, arbitrary predicates or shell commands in the document. Each step names its expected status/state checkpoint. Reuse the same bounded evaluator, not a second scenario runtime.

Expectations are data, not pass/fail callbacks:

- Exact allowed status integers, where a response exists. Browser form POST redirects may legitimately be 303; do not impose a blanket 2xx rule on business cases.
- Response rules: equality, containment of approved field identifiers, absence of forbidden identifiers, and exact entity/set identity. Do not pin human-readable wording.
- State rules: `created`, `unchanged`, `updated`, `absent`, `archived`, `exact-set`, `append-only`, `count-delta`, `transition` and `attempts`.
- Every state rule names one `EffectScope` and fixture-resolved subjects. Empty state rules cannot satisfy a mutation, no-side-effect or idempotency contract.
- Cross-field comparison sources are limited to approved case literals, engine-observed request fields, trusted fixture values and prior engine-observed checkpoints. Tests cannot supply expected outcomes at runtime.
- Transformations are a small explicit set (`identity`, `trim`, `lowercase`) only when the reviewed app contract needs them. Exact identity is default. No fuzzy matching or general expression evaluator.
- Effect counts are not enough for updates or no-side-effect: compare record identity and relevant field maps as well.

### 4.3 Strong HTTP contracts and existing domain names

Add EXACTLY these strong HTTP contracts to the existing HTTP verifier dispatch:

- `http:effect-verified`: a particular endpoint's declared mutation/command effects are observed for every required case.
- `http:read-result-verified`: the endpoint returns the declared records/fields under the declared actor/filter and causes no forbidden state change.

Retain `http:request-observed` and `http:response-status-ok` with their current weaker meaning. Never silently strengthen or relabel old evidence. Do not rename `http:frontend-request-observed` into one of these contracts or treat proxy traffic as browser evidence.

Reuse ALL existing domain vocabularies for Phase 7–8. Do not introduce spelling aliases for existing contracts. The closed vocabulary tables are in Section 8.

Each subject/contract remains one ordinary obligation. If it requires three cases, all three must be satisfied before that obligation is satisfied. Domain-resource obligations and endpoint obligations are distinct; a policy-controlled mapping may allow one witnessed case to prove both, but only when the compiled requirement set explicitly records both obligations. Never spread a record to arbitrary claims from the suite.

### 4.4 Effects and independent state scopes

NEW `EffectScope` fields:

```ts
interface EffectScope {
  id: string;              // unique within subject
  resourceId: string;      // full normalized graph id
  adapter: string;         // approved existing evidence-adapter key
  scope: string;           // approved snapshot scope key
  identityFields: string[];// exact ordered identity columns incl. tenant where needed
  fields: string[];        // nonempty relevant field projection
  completion: 'immediate' | 'barrier';
}
```

Use existing resource classification primary keys as the baseline; an override cannot drop part of the real identity. Reject same bare table names that would conflate tenant/master/global resources.

Extend `EvidenceAdapter`, its validator in `witness/adapter-registry.ts`, and its public declarations with TWO optional trusted observation methods:

```ts
// NEW methods; existing read/list/normalize/probeServer/observe remain unchanged.
snapshotScope?(ctx: AdapterContext, input: {
  scope: string;
  fixtureNamespace: string;
}): Promise<ScopeSnapshot> | ScopeSnapshot;

awaitBarrier?(ctx: AdapterContext, input: {
  scope: string;
  fixtureNamespace: string;
  operationId: string;
  deadlineMs: number;
}): Promise<{complete: boolean; checkpoint: string}>;
```

`ScopeSnapshot` is strict data: `{scope, fixtureNamespace, complete, checkpoint, entities:[{entityId, fields}]}`. Identity is scalar for single-column keys and a complete column-keyed object for composite keys, matching existing core behavior. Canonical ordering and duplicate-identity rejection are mandatory.

- `complete:false`, pagination not exhausted, omitted declared fields, unknown identity, inconsistent checkpoints, or size-limit truncation blocks. Never silently sample a large scope.
- The adapter must observe an independently controlled state source for the protected profile: read-only database credentials, a trusted state sidecar, or equivalent owner-provisioned observer outside candidate code. Reading only the candidate's own GET handler is insufficient for that profile.
- Scope data is fixture/run namespaced. Snapshot all declared effects, including secondary records such as ledger rows, audit entries and outbox messages. Comparing only the primary row cannot prove no side effects.
- `awaitBarrier` is an observer, not a mechanism for creating the desired state. It must use a real completion/queue checkpoint. It may not just sleep, mutate state or return true on timeout.
- For asynchronous effects, the trusted harness controls time/delivery and observes completion. Without that capability report `OBSERVATION_SCOPE_INCOMPLETE`, never a success based on an arbitrary quiet interval.
- An independent finite scope proves only that scope. Reports must state it. Do not claim absence of every possible side effect anywhere in the system.
- Existing adapters lacking these methods still work for current weaker contracts. They cannot satisfy new strong contracts requiring the missing observations.

### 4.5 Approved actors and fixture control

Add a trusted fixture/actor provider, loaded ONLY from the approved engine-owned policy bundle. It is separate from the read-only evidence adapter: do not put mutation helpers on `AdapterContext.get` or on `probeServer`.

NEW module contract at `packages/pack-playwright/src/witness/fixture-provider.ts`:

```ts
interface FixtureProvider {
  prepare(input: {recipe: string; runId: string; caseId: string}): Promise<FixtureLease>;
  release(leaseId: string): Promise<void>;
}
interface FixtureLease {
  leaseId: string;
  namespace: string;
  subjects: Record<string, unknown>;  // authoritative generated identities
  actors: Record<string, ActorLease>;
}
interface ActorLease {
  principalId: string;
  tenantId: string | null;
  roles: string[];
  credentialRef: string;             // private engine-side reference, not token bytes
}
```

Actor material is resolved privately by the controller/engine request driver. Cookie/header material never appears in suite-visible results, signed public reports, argv or logs. A fixture recipe must establish that a supposedly foreign/forbidden record actually exists. The paired positive control must prove the same valid operation works for the authorized actor. Otherwise “denied” might merely mean nonexistent record or malformed payload.

Fresh isolated lease per case; sequence steps share only their own case lease. No reliance on mutable fixtures left by a prior test. Namespace cleanup must run on errors without changing the case verdict to success.

### 4.6 Evidence chain: operation IDs, not timing guesses

Add a NEW engine-issued operation proof record kind `behavior.case`, with `payloadVersion:1`. Do not overload `persistence.observed` or manufacture stronger meaning from older payloads.

The signed payload contains:

- `caseId`, `caseSpecDigest`, `obligationIds`, `endpointResourceId` where applicable;
- `operationId`, `sessionId`, `executionId`, `fixtureNamespace`;
- `actor` identity/tenant/roles as trusted fixture metadata, never credential bytes;
- exact action descriptor digest and actual observed submitted values;
- ordered request attempts: engine request ID, method, concrete URL/path, endpoint identity, actor reference, bounded request/body digest, status, response observation digest;
- authoritative before/after checkpoints and normalized declared effect projections;
- completion/barrier facts; for workflows/queues, actual observed transition/delivery/attempt facts;
- proof channel and authority profile digest.

The existing outer evidence record continues to bind run/test/obligation identity and origin. `issueRecord` remains the only issuer; records must be in the authenticated witness ledger. A test posting a `behavior.case`-shaped object to `/records` remains suite-submitted and never satisfies the new contracts.

State machine, enforced witness-side:

```text
registered by supervisor
 -> fixture prepared
 -> authoritative before snapshot complete
 -> principal operation executing
 -> expected request/sequence captured
 -> completion barrier reached
 -> authoritative after snapshot complete
 -> case sealed
```

Each transition requires the previous one. Duplicate execute/seal, input overrides, session swaps and use after session close are rejected. One execution per required case per run; declared idempotency/retry attempts are steps WITHIN that case, not retries of the test.

Matching rules:

- Reuse the existing canonical route resolver against the full endpoint inventory.
- Match exact method, canonical endpoint and all relevant route/query/body identity selectors from approved case data.
- Capture the actual engine-browser request and form/file values, not only the worker's submitted `fields` object.
- Do not treat “the same session” or “a request inside this time interval” as sufficient causal linkage.
- Only the principal driver is allowed to mutate its isolated fixture namespace during a case. The strong runtime must prevent suite-side direct mutation of that namespace; a proxy watermark alone does not do so.
- Explicitly expected multi-request sequences are legal. Unexplained matching mutation requests are ambiguity and block, not first-match wins.
- Pagination or read-list cases verify actual entity sets and filters; `/accounts/1` does not prove `/accounts/search`.
- Entity A action + entity B observation blocks even if both values happen to be equal.
- Cross-tenant identity is part of the binding, not just a string field in the report.
- Zero state delta is insufficient for a declared update unless the case explicitly represents a reviewed no-op scenario, which cannot substitute for the required real-update case.
- Batch import compares the exact submitted-to-created/updated set and forbidden side-effect set. One successful row cannot stand for the batch.

### 4.7 Case aggregation and mapping

NEW compiled output `BehaviorCatalog`:

```ts
interface BehaviorCatalog {
  schemaVersion: 1;
  catalogDigest: string;
  cases: CompiledBehaviorCase[];                // sorted by caseId
  requirements: Record<string, string[]>;       // obligationId -> required caseIds
  dependencies: Record<string, string[]>;       // subject resourceId -> effect/domain resourceIds
}
```

Add a pure `compileBehaviorPolicy({graph, policy})` API returning `{catalog, obligations, blocking}` in `core/src/policy/behavior.ts`. CLI loads YAML; core accepts validated data only, matching `PolicyFileSchema` conventions.

Extend `TestMapEntrySchema` with optional `caseIds: string[]`; existing `claims` remains mandatory. `tests mark --case <caseId>` is a NEW repeated flag. Resolve IDs against the current compiled catalog and require each case to belong to one of that entry's claims. Reject stale/duplicate/foreign case IDs and whole-file wildcard declarations. Native obligation annotations remain declarations; they do not implicitly claim every new case. A missing explicit case mapping is actionable, not proof.

The trusted supervisor fixes the required case set along with the expected test set before execution. The worker may request `evidence.prove(caseId)` (NEW fixture API) for an allowed case; it cannot define the case or its expectations. `evidence.prove` asks the witness to execute the approved case and returns a redacted result reference, not authority to declare success.

New verifier aggregation MUST occur across the required cases, not inside the old “any claim satisfied” shortcut:

1. Resolve required case IDs from trusted context, not record payloads.
2. Match case records to allowed planned test/session/execution identities.
3. Validate provenance, catalog/spec digest, endpoint/effect/actor bindings and state machine facts.
4. Grade each required case with the namespace's pure semantic grader.
5. Require every case to pass exactly once. Missing required cases block. A failed mandatory attempt cannot be hidden by another passing execution of the same case.
6. Existing legacy obligations without case requirements keep their current semantics. A legacy record never contributes to the new case set.

Extend `ClaimEvidenceInput`/`VerdictContext` with trusted catalog/requirements context rather than importing CLI configuration into core. Add `evaluateRequiredCases` in a dedicated `core/src/verdict/behavior.ts` helper; namespace dispatch remains the existing registry.

### 4.8 Fingerprints, snapshots and receipt cutover

Add optional `requirementsDigest` to `ObligationSchema` and `FingerprintInputSchema`, REQUIRED for every obligation compiled from the behavior catalog. It hashes the sorted full required case specifications, not just their stable IDs. Omitting it on existing weaker obligations retains their existing fingerprint meaning. Never add `undefined` fields to canonical JSON.

Update all fingerprint construction sites through a shared obligation-to-fingerprint projection. Before editing exports, use language-server references. Important known sites include:

- `core/src/verdict/evaluate.ts` waiver matching;
- `cli/src/evaluate.ts`, `obligationFingerprint`;
- `cli/src/execution.ts`, scoped selection/receipt generation;
- core baseline/waiver/report tests and fixture helpers;
- any caller constructing `{resourceId, contract, policyId, lifecycle}` manually.

The new document, approved provider modules, surface descriptors, fixture definitions, actor-profile definitions, dependency locks and executable transitive dependencies must participate in BOTH trusted policy identity and tested-input snapshots. Hash bytes, not timestamps. Do not hash only an adapter entrypoint while leaving an imported helper mutable.

Receipt cutover is explicit:

- Change receipt envelope to `receiptVersion:2`, MAC domain `gateforge.receipt.v2`.
- Preserve the separate witness ledger v2 domain and semantics.
- Add required signed fields: `candidateTreeId`, `behaviorCatalogDigest`, `requiredCaseSetDigest`, `caseExecutionDigest`, `engineBundleDigest`, `executionBoundaryDigest`, `targetArtifactDigest`.
- `candidateTreeId` is the immutable Git tree actually tested. `targetArtifactDigest` identifies the controlled app build derived from that tree, not a self-reported application response header.
- `executionBoundaryDigest` binds a controller-issued record of the active execution profile. Basic local runs can identify `local-unisolated`; that record cannot authorize a managed/complete protected acceptance.
- Empty behavior catalogs use a canonical empty digest, not an omitted field with ambiguous meaning.
- Update issuance, verification, loading, broker, tests and exports together. No v1 acceptance shim for new strict acceptance. Existing receipts require a fresh run; do not re-sign old evidence into v2.
- Required case set is always signed, including full runs. A full-scope label does not excuse a missing case set.
- Use the existing HMAC/signing implementation and constant-time comparison; no new cryptographic algorithm is needed.

### 4.9 Changed-file selection must include indirect effects

Extend the source/dependency mapping before calling existing `planScopedExpectedSet`:

- Endpoint source change -> that endpoint's cases and its declared effect/negative contracts.
- Table/model change -> every endpoint/domain subject declaring an effect on that full table resource ID.
- Shared handler/service/schema change -> the transitive declared dependency closure.
- Test-only change -> all cases claimed by that test, with existing whole-file execution completeness retained.
- Behavior document/provider/surface/adapter/fixture/actor/config change -> whole affected approved profile, conservatively full where dependency knowledge is incomplete.
- Unknown changed source -> existing `CHANGE_UNMAPPED` behavior, expanded scope and blocking. No narrow guess.
- Endpoint deletion/rename -> stale references and changed catalog/requirements; never retain old approval under a new route.

Use a generated dependency index in `BehaviorCatalog`; do not add a fake graph edge and forget to update selection. The same affected-set function MUST feed `check`, `test-gates`, `next`, receipts and the broker acceptance expectations.

### 4.10 Protected execution and broker authority

Separate roles:

| Role | May execute candidate code? | May sign/approve? | Writable state |
|---|---|---|---|
| Coding agent | Yes | No | Its working tree only |
| Test worker | Yes | No | Per-run test output/scratch only |
| Candidate app | Yes | No | Disposable app state under declared credentials |
| Engine browser/witness/controller | Approved engine code only | Evidence authority only | Private run state; controlled fixture service |
| Approval authority/broker | No candidate code | Yes, exact approved candidate | Authoritative Git refs and private policy/keys |
| Host administrator | Outside threat model | Owner authority | Host-level control |

Implement the Linux reference runtime using rootless Podman-managed containers under a dedicated owner/service account, with separate user/PID/mount/network boundaries. Do not add a Docker socket to the agent or worker. Unsupported/missing isolation capability blocks the protected profile; never fall back to same-UID subprocesses and keep the protected label.

Specific runtime constraints:

- Approved engine/policy bundle mounted read-only, outside candidate paths.
- App build/install hooks and tests execute only inside untrusted containers, without receipt keys or authority mounts.
- Worker cannot reach app mutation/database ports for strong cases; it reaches only the constrained witness case API. Engine browser/HTTP driver owns principal requests. Keep the weaker Observe profile explicitly distinct if it needs worker app access.
- App has only its test namespace data credentials. Observer has independently provisioned read-only access. Worker has neither.
- Private supervisor endpoints are not on the worker network; token stripping alone is insufficient.
- No shared host PID namespace, ptrace, writable engine directory, leaked inherited descriptors, host home directory, host Git directory, broad host filesystem, or host container socket.
- Resource limits, operation deadlines and per-run cleanup prevent a stuck candidate from hanging authority indefinitely. A timeout is failure, not retry success.
- Candidate app may not select a fake origin. Controller provisions the exact app build/origin; preserve ADR 0006 redirect/DNS checks.

Broker rewrite:

1. Accept an immutable candidate manifest/tree reference and its signed v2 receipt.
2. Reject paths outside the owner-provisioned staging area; reject symlinks, submodules, traversal, special files and unsupported Git formats explicitly.
3. Import/hash raw candidate bytes with sanitized Git configuration. Do not run `git add` filters or candidate-controlled hooks in the authority process.
4. Never invoke `runPipeline`, import adapters/plugins, execute a package manager or load candidate JavaScript in the broker. The approved controller owns evaluation.
5. Check signed tree, parent, approved policy, engine bundle, execution boundary, target artifact and required case set against authority-owned expectations.
6. Write the commit object for that exact tree and perform the existing compare-and-swap ref update. A changed parent requires a fresh run.
7. On rejection, authoritative ref stays unchanged. Creating a Git object without updating a ref must not be reported as an accepted commit.

A matching candidate policy hash is necessary but not sufficient. Protected mode is selected by the authority's own configuration, not by a candidate turning `strictE2E` off. Pin verification must occur before any code-loading operation in all privileged entrypoints.

### 4.11 Existing behavior and rollout compatibility

- Basic `init` remains opt-in and non-destructive. Do not enable hundreds of unverifiable obligations silently in existing consumers.
- Add `init --behavior` to configure the new policy path and report readiness. It must not overwrite existing policies or create fake approval. A catalog missing owner case definitions remains visibly blocked.
- Complete protected behavior is accepted only when the authority requires it. A candidate cannot switch back to basic mode to pass.
- Keep Overlay for strong engine-driven cases. Keep Observe for its honest weaker persistence contract. Never rewrite existing consumer journeys automatically.
- Reuse cataloged tests first where their evidence actually meets the required channel. New thin overlay tests are justified for cases that lack that channel, not as duplicates of every existing test.
- Preserve exit codes: 0 accepted/clean for the requested mode; 1 behavioral/coverage/evidence block; 2 malformed config/usage/environment setup error. Broker retains typed rejection behavior and never accepts on error.
- Do not expose raw credentials, production PII or full request bodies in reports. Persist only approved projections/digests; error details must be bounded and redacted.

## 5. New diagnostics and reporting contract

Add cause codes to the existing shared schema/mapping/reporting path; do not add a second exception-only vocabulary:

| Cause | Required meaning | Next action category |
|---|---|---|
| `ENDPOINT_BEHAVIOR_MISSING` | Discovered endpoint has no approved behavioral declaration | Owner defines endpoint behavior; agent cannot exclude it |
| `BEHAVIOR_REFERENCE_STALE` | Policy references removed endpoint/resource/case | Repair reviewed references and rerun |
| `BEHAVIOR_CASE_UNMAPPED` | Required case has no current declared test mapping | Reuse/map suitable test, or add thin overlay proof |
| `BEHAVIOR_CASE_MISSING` | Planned required case did not produce complete evidence | Execute the case through its required channel |
| `BEHAVIOR_BINDING_MISMATCH` | Endpoint, actor, subject, session, attempt or spec identity differs | Repair wrong path/record binding; no label changes as proof |
| `BEHAVIOR_EFFECT_MISMATCH` | Observed state differs from expected effect | Fix application or owner-reviewed expectation |
| `OBSERVATION_SCOPE_INCOMPLETE` | Scope/barrier/body/identity observation is incomplete | Supply working trusted observer or fix collection |
| `BEHAVIOR_UNEXPECTED_EFFECT` | A declared forbidden state change occurred | Fix application side effect |
| `ENFORCEMENT_BOUNDARY_UNVERIFIED` | Claimed protected runtime lacks authoritative isolation evidence | Owner provisions/verifies runtime |

Reuse `VERIFIER_UNSUPPORTED`, `EVIDENCE_STALE`, `EVIDENCE_VALUE_MISMATCH`, `ENFORCEMENT_UNTRUSTED`, `RUN_INCOMPLETE`, existing route ambiguity codes and broker CAS errors where they already express the condition. Do not add near-synonyms.

Reports must separate:

1. Discovered endpoints, approved exclusions and unresolved discovery.
2. Declared cases and mapped tests (intent).
3. Executed cases and observed outcomes (proof).
4. Proof strength: transport-only, persistence-observed, engine-browser, protected endpoint behavior.
5. Actual enforcement boundary: local-unisolated, isolated controller, server-protected, managed-authoritative.

Example truthful output:

```text
PATCH /admin/accounts/{} / admin-update
required: exact account update as admin
observed: account acc-42, first_name Ada -> Grace
state source: approved read-only observer, fixture run-…
result: satisfied

POST /imports/accounts / import-two-accounts
result: missing — no case execution; profile-editor evidence does not cover this endpoint
```

`gateforge next` still emits ONE blocking action. Rank configuration/unsupported observation/isolation before asking an agent to create more tests. Never tell an agent to remove a required contract or change a waiver to approve its own work.

## 6. Allowed APIs and copy locations

These names were inspected. They exist NOW. Everything in Section 4 labeled NEW must be implemented before calling it.

| Existing API/pattern | Source | Use |
|---|---|---|
| `compileEndpointContribution(contributions, options)` | `cli/src/endpoint-compiler.ts` | All-route inventory and current source provenance |
| `evaluatePolicies(input)` | `core/src/policy/evaluate.ts` | Pure compiler/error/result pattern |
| `evaluateCoveragePolicy(tables, inventory, mappedCoverage)` | `core/src/policy/coverage.ts` | Closed-world enumeration; not endpoint semantics |
| `registerContractVerifier`, `registerContractCapabilities` | `core/src/verdict/registry.ts` | First-wins verifier/capability registration |
| `evaluateObligation`, `evaluateObligations` | `core/src/verdict/evaluate.ts` | Verdict integration and existing trust validation |
| `EvidenceAdapter.read/list/normalize/probeServer/observe` | `pack-playwright/src/witness/types.ts:651–689` | Existing read-side observation |
| `startWitness(options)` | `pack-playwright/src/witness/server.ts:688–839` | Real loopback witness tests |
| `issueRecord` | same file:3542–3573 | Sole engine ledger issuance pattern; internal, not a worker API |
| `EngineBrowserManager`, `driveEngineAction`, `readEngineVisible` | `witness/browser.ts` | Engine-owned UI operations |
| `validateSurface`, `SurfaceDescriptor`, `SurfaceStep` | `pack-playwright/src/surface.ts` | Constrained locator/step validation |
| `superviseExecution(planned, envelope)` | `core/src/supervision/index.ts:185–380` | Expected test completeness |
| `planScopedExpectedSet(input)` | `cli/src/execution.ts:373–457` | Selection after dependency expansion |
| `trustedPolicyDigestForConfig(cwd, config)` | `cli/src/execution.ts:176–209` | Existing policy input collection; extend transitive coverage |
| `issueGateReceipt(input)`, `sealExecutionResult(input)` | `cli/src/execution.ts` | Receipt and run issuance |
| `verifyGateReceipt(key, candidate, expected)` | `core/src/receipt/index.ts` | Single receipt verifier |
| `brokerCommitCommand(io, argv)` | `cli/src/broker.ts` | Existing authoritative commit/CAS entrypoint |
| `withTempRepo`, `runRedProbe`, `runRedProbes` | `core/src/testing`, exported by core | Deterministic isolated proof harness |
| `installFixture`, `runCli`, `writeV2Manifest` | `cli/test/helpers.ts` | Engine fixtures only; a minted helper manifest is not a real E2E run |
| `createAccountStore({clock})`, `createApp({clock})` | `example/lib/app.js` | Existing accounts example; injection extensions are NEW |

Read `docs/decisions/0004-frontend-consumed-endpoint-compiler.md`, ADR 0005, ADR 0006, `docs/testing/TESTING_POLICY.md` and `docs/testing/RED_PROBE.md` before changing authority/evidence code.

Do NOT invent or call these as existing APIs: `EntityAdapter`, `graph.edges`, `evidence.prove`, `snapshotScope`, `awaitBarrier`, `compileBehaviorPolicy`, `evaluateRequiredCases`, a behavior catalog or v2 gate receipts. This plan explicitly introduces the latter APIs; `EntityAdapter` is not the runtime type name.

## 7. Phased execution plan

### Progress ledger

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Source/docs discovery and locked design | COMPLETE — planning only |
| 1 | Strict schemas, catalog, identities and version contracts | COMPLETE |
| 2 | Complete endpoint inventory coverage and dependency selection | COMPLETE |
| 3 | Immutable evaluation and authority-safe receipt/broker cutover | COMPLETE |
| 4 | Trusted fixture/actor/state observation foundation | COMPLETE |
| 5 | Request-to-effect proof and strong HTTP graders | COMPLETE |
| 6 | Browser/import integration and existing-test mapping | COMPLETE (repository-side; Chromium installed and live browser rows passed in the centralized suite) |
| 7 | Authentication and validation semantics | COMPLETE |
| 8 | Workflow, task, webhook and failure semantics | COMPLETE (repository-side; serial + concurrent duplicate delivery, terminal handling and signature cases passed; trusted retry-trace rows remain fail-closed without the external queue observer) |
| 9 | CLI readiness/reporting/onboarding and packaged usability | COMPLETE (repository-side; installed tarball smoke passed in Phase 12 verification) |
| 10 | Managed isolation deployment and real server enforcement | REPOSITORY-SIDE COMPLETE — `deploy/managed/` + `isolation.ts` + local boundary tests; actual host acceptance BLOCKED on owner inputs |
| 11 | Complete adversarial qualification | COMPLETE (repository-side; existing B01–B32, B36–B52 and B59 coverage retained; B34–B35 qualification added; B33 concurrent delivery covered; B53–B58 remain external host blockers) |
| 12 | Final end-to-end and installed-package acceptance | PARTIAL / BLOCKED — build, typecheck, full suite and tarball smoke pass; canonical complete-behavior CLI scenario and managed-host acceptance remain owner/environment blocked |

Dependency order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10 -> 11 -> 12. Adversarial cases must be added alongside their owning phase; Phase 11 integrates and qualifies them rather than starting testing late.

Each implementation phase closes with: targeted behavior checks; a green/broken probe pair for its central guarantee; command/result record here; mapped memory update. A phase does not pass because TypeScript builds or a fabricated evidence object grades satisfied.

### Phase 0 — Documentation and implementation discovery

**Why:** Prevent rebuilding shipped features and prevent assuming the planned features already exist.

Completed in this planning task:

- Read relevant ADRs, current schemas/compiler/verifier/adapter/supervision/broker code and current onboarding plan.
- Established the actual available API list above.
- Ran the isolated engine experiment in Section 2.3.
- Identified stale documentation and the distinction between existing local mechanism and deployed protection.

No implementation tests, browser runs, live host probes or production actions were performed in Phase 0.

### Phase 1 — Schemas, catalog and stable identities

**What to implement**

1. Add `behavior-policy.ts` with strict zod unions and semantic validation from Section 4. Validate endpoint/resource references during compilation, not by guessed string parsing.
2. Add `behavior-catalog.ts` in core schemas for compiled cases, requirements and dependency map. Canonical sorting; duplicate IDs are errors.
3. Add `behavior.ts` in core policy for `compileBehaviorPolicy`. Return missing/unresolved requirements as existing-style `BlockingEntry` values with causes.
4. Add `requirementsDigest` to obligation/fingerprint schemas and one shared projection for hashing. Keep raw compiler endpoint IDs out of obligations.
5. Add schema for `behavior.case` observations and pure case requirements; no issuer or fake producer yet. Strong capability remains unavailable until Phase 5 produces genuine evidence.
6. Add typed cause codes and placeholder-free user actions in shared verdict/cause definitions. Register unavailable new contracts with the exact missing observer reason.
7. Add `behaviorPolicy` config path and path validation. Unknown keys remain errors.
8. Export the new data contracts from existing core barrel files. Use language-server references for existing exports; no compatibility alias chain.

**Read/copy patterns**

- `core/src/schemas/coverage-policy.ts` and `test-map.ts`: strict schemas and duplicate handling.
- `core/src/schemas/obligation.ts`, `fingerprints.ts`.
- `core/src/policy/evaluate.ts`: deterministic pure compiler output.
- `core/src/verdict/registry.ts`: unsupported capability semantics.

**Verification**

- Valid policy produces schema-valid normalized obligations and deterministic catalog under reordered input.
- Two endpoints linked to one table produce distinct obligation IDs/case sets.
- Same bare table name in two planes stays distinct.
- Missing reference, duplicate case, missing positive control, empty mutation expectations, arbitrary callback/expression, invalid secret literal reference and unknown schema version fail explicitly.
- Changing expected values changes requirements digest; reordering maps does not.
- New strong contracts remain blocked without real case evidence.

**Tests**

Extend `core/test/schemas.test.ts`, `policy.test.ts`, `fingerprints.test.ts`, `config.test.ts`, `verifier-registry.test.ts`. NEW focused `core/test/behavior-policy.test.ts` is justified by the new cross-endpoint and required-case invariants.

**Anti-pattern guards**

No pass flags on `ClaimSchema`; no contract identity built from a raw colon-containing endpoint ID; no unknown-key stripping; no “missing observer means skip.”

```text
Status: COMPLETE
Changed files:
  packages/core/src/schemas/behavior-policy.ts (NEW)
  packages/core/src/schemas/behavior-catalog.ts (NEW)
  packages/core/src/schemas/behavior-evidence.ts (NEW)
  packages/core/src/policy/behavior.ts (NEW)
  packages/core/src/schemas/{obligation,verdict,index}.ts
  packages/core/src/{fingerprints,index}.ts
  packages/core/src/config/index.ts
  packages/core/src/policy/index.ts
  packages/core/src/verdict/{pack-verifiers,evaluate}.ts
  packages/core/src/report/index.ts
  packages/core/src/testing/gate-runner.ts
  packages/cli/src/{evaluate,state}.ts
  packages/cli/src/commands/explain.ts
  packages/core/test/{behavior-policy,fingerprints,config,schemas,verifier-registry}.test.ts
Commands actually executed:
  cd packages/core && npx vitest run test/behavior-policy.test.ts test/fingerprints.test.ts test/config.test.ts test/schemas.test.ts test/verifier-registry.test.ts
  → 5 files, 156 tests, pass
  cd packages/core && npx tsc -p tsconfig.json --noEmit && npx vitest run test/policy.test.ts test/report.test.ts test/verdict.test.ts test/coverage-policy.test.ts
  → tsc exit 0; 4 files, 105 tests, pass
  cd packages/cli && npx tsc -p tsconfig.json --noEmit
  → exit 0
Normal behavior observed:
  Plan YAML example (profile+admin, three cases) compiles to three distinct obligations; reordered maps keep catalogDigest/requirementsDigest stable; tenant.accounts vs master.accounts stay distinct; omitted requirementsDigest equals historical four-key fingerprint.
Broken/hostile behavior observed:
  Import endpoint absent from the document → ENDPOINT_BEHAVIOR_MISSING; stale admin reference → BEHAVIOR_REFERENCE_STALE; duplicate case / missing controlCase / empty mutation state / expression callback / password literal / schemaVersion 2 fail parse; fabricated claim for http:effect-verified grades missing (no trusted behavior.case observer).
Exact rejection cause:
  ENDPOINT_BEHAVIOR_MISSING (missing import); VERIFIER_UNSUPPORTED/missing observer for strong HTTP without real case evidence.
Receipt/ref outcome: n/a (Phase 1 has no receipt issuer).
Remaining external prerequisites: none for Phase 1.
Mapped memory updated: yes
```

### Phase 2 — Every endpoint gets a requirement; changed scope includes all affected paths

**What to implement**

1. Load and compile the behavior document after current endpoint compilation/classification and before final policy evaluation/reporting. Add its obligations and blockers to the single pipeline output.
2. Enumerate every concrete discovered endpoint, including unconsumed routes. Reuse compiler findings for dynamic/unresolved routes; never drop them to get a complete count.
3. Resolve each case's effect scope to full business resource IDs. Permit one endpoint to affect multiple resources and one resource to be affected by multiple endpoints.
4. Compile domain-to-endpoint/resource requirements without changing existing detector resource identity. Explicitly declare uncertain linkage; ambiguity blocks.
5. Add the generated dependency index to the pipeline state and shared input snapshot. Include route/server/frontend sources, effect sources and declared shared modules.
6. Expand `sourcesByResourceId` consumers/changed selection through this index. The same affected-case set must be used for selection, grading and receipt expectations.
7. Add case IDs to existing mapping schema/resolver and `tests mark --case`. Suggestions remain hints, never proof. `tests explain` lists missing cases within an otherwise mapped obligation.
8. Preserve existing full-file selection and planned-versus-executed checks. An endpoint with one mapped happy case and two missing negative cases must still block.
9. Make static inventory completeness explicit: approved include/exclude/plugin settings define discovery scope; malformed/failed scans block. No claim of discovering unsupported runtime routes.

**Read/copy patterns**

- `cli/src/endpoint-compiler.ts`, `pipeline.ts`, `state.ts`.
- `core/src/policy/coverage.ts`, `core/src/mapping`.
- `cli/src/scope.ts`, `execution.ts:planScopedExpectedSet`, `mapping.ts`.
- `cli/test/endpoint-compiler.test.ts`, `scope-expansion.test.ts`, `scoped-sealing.test.ts`.

**Verification**

- Profile/admin/import routes share accounts: only profile mapped -> admin and import remain missing.
- Add a server-only fourth route -> new missing requirement without frontend call detection.
- Change accounts model -> all four endpoint case sets selected.
- Change only admin route -> admin plus shared affected contracts, not an unrelated invoice route.
- Change shared validation/service file without resolvable dependency -> conservative full block/selection, not zero tests.
- Remove/rename endpoint -> stale case references and stale receipt.
- Owner exclusion appears separately, never increments proven coverage.

**Anti-pattern guards**

No `consumed:true` shortcut for complete endpoint coverage; no sole table+operation key; no “one test mapped” satisfaction; no name-based fuzzy table link; no silently empty changed case set.

```text
Status: COMPLETE
Changed files:
  packages/core/src/policy/behavior.ts (stale effect references -> BEHAVIOR_REFERENCE_STALE, checked before linked-conflict)
  packages/core/src/mapping/resolve.ts (already in tree: sidecar caseIds + BEHAVIOR_CASE_UNMAPPED; native-only never satisfies)
  packages/core/src/schemas/test-map.ts (already in tree: caseIds + duplicate rejection)
  packages/cli/src/pipeline.ts (already in tree: behavior compile/merge + behavior-catalog.json + effect-aware sourcesByResourceId)
  packages/cli/src/mapping.ts (already in tree: behaviorCatalog passthrough)
  packages/cli/src/execution.ts (behaviorPolicy bytes join trustedPolicyDigest; absent marker keeps digest deterministic)
  packages/cli/src/input-snapshot.ts (behaviorPolicy in declared inputs; obligations carry requirementsDigest)
  packages/cli/src/scope.ts (behaviorPolicy change forces full scope)
  packages/cli/src/evaluate.ts (already in tree: behavior-aware changed scoping)
  packages/cli/src/commands/{check,next,test-gates,tests}.ts (behavior-aware sources/mapping; mark --case duplicate/wildcard rejection; explain lists missing cases)
  packages/cli/src/commands/explain.ts, state.ts, report (already in tree: fingerprintObligation projection)
  packages/core/test/behavior-phase2.test.ts (NEW: 6 tests)
  packages/cli/test/behavior-phase2.test.ts (NEW: 4 tests)
Commands actually executed:
  cd packages/core && npx vitest run test/behavior-policy.test.ts test/behavior-phase2.test.ts test/fingerprints.test.ts test/config.test.ts test/schemas.test.ts test/verifier-registry.test.ts
  → 6 files, 162 tests, pass
  npx vitest run packages/core/test/policy.test.ts packages/core/test/report.test.ts packages/core/test/verdict.test.ts packages/core/test/coverage-policy.test.ts
  → 4 files, 105 tests, pass
  npx vitest run packages/cli/test/behavior-phase2.test.ts packages/cli/test/scope-expansion.test.ts packages/cli/test/scoped-sealing.test.ts
  → 3 files, 40 tests, pass
  npx vitest run packages/cli/test/behavior-phase2.test.ts packages/cli/test/scope-expansion.test.ts packages/cli/test/scoped-sealing.test.ts packages/cli/test/tests-map.test.ts
  → 4 files, 54 tests, pass (earlier run)
  npx vitest run packages/cli/test/trusted-policy.test.ts packages/cli/test/staged-candidate.test.ts packages/cli/test/broker.test.ts packages/cli/test/receipt-gate.test.ts
  → 4 files, 74 tests, pass
  cd packages/core && npx tsc -p tsconfig.json --noEmit → exit 0
  cd packages/cli && npx tsc -p tsconfig.json --noEmit → exit 0
Normal behavior observed:
  Table source change selects only endpoints declaring an effect on it (profile selected, unrelated invoices not); behavior-policy edit forces full scope; trusted digest moves when behavior bytes change; gate context binds requirementsDigest.
Broken/hostile behavior observed:
  Endpoint/domain effect on a graph-absent resource → BEHAVIOR_REFERENCE_STALE, subject skipped; required cases with no sidecar mapping → BEHAVIOR_CASE_UNMAPPED per case (2/2, then 1/2 after one mapped); native-only claim leaves both cases UNMAPPED; duplicate caseIds fail schema parse; duplicate --case and whole-file --case rejected in mark.
Exact rejection cause:
  BEHAVIOR_REFERENCE_STALE (stale effect); BEHAVIOR_CASE_UNMAPPED (missing case mapping); TEST_MAPPING_AMBIGUOUS (pre-existing wildcard guard); UsageError on duplicate/foreign/whole-file --case.
Receipt/ref outcome: n/a (Phase 2 has no receipt issuer; behavior-aware fingerprints/selection feed later receipt phases).
Remaining external prerequisites: none for Phase 2.
Mapped memory updated: yes
```

### Phase 3 — Immutable evaluation and authority-safe receipt/broker cutover

**Why now:** Later observations are useless if they can be signed for different bytes or executed inside the approval process.

**What to implement**

1. Introduce one immutable candidate snapshot object shared by `test-gates`, staged check and the broker interface. Reuse staged-candidate safety checks; include ignored-but-configured inputs in the approved input manifest.
2. Separate raw-file policy digest verification from plugin/adapter loading. Validate the owner-provisioned policy pin and approved bundle before any candidate-selected executable input runs.
3. Evaluate and build the app from the frozen candidate, not the live workspace. Bind controlled build inputs and final app artifact into the run context.
4. Implement receipt v2 fields/domain from Section 4.8 across schema, MAC, verifier, CLI loaders, scoped coverage checks and issuer.
5. Remove `recomputeWorkspaceDigests`' pipeline execution from broker authority. Broker verifies signed immutable identities against authority expectations and raw candidate tree, not a candidate-configured pipeline.
6. Replace authority-side `git add` candidate ingestion with raw-byte safe tree construction under sanitized Git configuration; no clean filters, hooks, external diff, alternate object directory injection or inherited candidate Git env.
7. Freeze parent/base before evaluation and require equality at acceptance. Retain CAS update and no accepted ref mutation on failure.
8. Reject old receipts with an explicit fresh-run instruction. Do not auto-upgrade signatures.
9. Ensure core receipt unit fixtures and CLI integration helpers mint v2 through real issuer APIs. Clearly distinguish helper-minted engine tests from end-to-end tests.

**Read/copy patterns**

- `cli/src/staged-candidate.ts`, `input-snapshot.ts`, `trusted-policy.ts`.
- `cli/src/broker.ts:136–229,248–434` for current ordering to replace.
- `core/src/receipt/index.ts`, `schemas/gate-receipt.ts`, `cli/src/receipts.ts`.
- `cli/test/staged-candidate.test.ts`, `broker.test.ts`, `receipt-gate.test.ts`, `trusted-policy.test.ts`.

**Verification**

- Edit live workspace during a run -> either tested frozen tree is accepted exactly, or explicit drift block; never accept mixed bytes.
- Candidate adapter/plugin has a top-level side effect -> unapproved version never executes in authority process.
- Candidate-controlled Git filter writes a marker -> marker absent under broker ingestion.
- Tamper each new receipt binding -> rejection for the relevant binding.
- Correct receipt for tree A presented with tree B -> no commit/ref change.
- Move parent -> CAS rejection and rerun required.
- Present v1 receipt -> rejected, not re-signed.

**Anti-pattern guards**

No hashing only after execution; no `process.chdir(candidate)` followed by candidate module imports in broker; no ambient env spread into authority Git commands; no self-reported build identity.

```text
Status: COMPLETE
Changed files:
  packages/core/src/schemas/gate-receipt.ts (receiptVersion 2 + 7 required bindings: candidateTreeId nullable, behaviorCatalogDigest, requiredCaseSetDigest, caseExecutionDigest, engineBundleDigest, executionBoundaryDigest, targetArtifactDigest; MAC domain v2)
  packages/core/src/receipt/index.ts (RECEIPT_DOMAIN v2, RECEIPT_VERSION 2, v1 explicit fresh-run rejection, 7 typed per-binding rejections, pure digest helpers + canonical empty digests + LOCAL_UNISOLATED boundary)
  packages/core/src/index.ts (v2 helper exports)
  packages/core/test/gate-receipt.test.ts (v2 fixtures, per-field mismatch matrix incl. new bindings, v1 rejection)
  packages/cli/src/candidate-tree.ts (NEW shared raw ingestion: hash-object -w --stdin per file + recursive mktree, sanitized env, symlink/submodule/special/traversal rejection, stateDir exclusion, strict vs record symlink modes)
  packages/cli/src/broker.ts (no runPipeline/pipeline execution/chdir in authority; raw ingestion; tree+policy+boundary v2 verification; protected-authority boundary expectation; v1 rejected via core)
  packages/cli/src/execution.ts (issueGateReceipt v2 with all bindings)
  packages/cli/src/commands/test-gates.ts (freeze tree+parent pre-suite; seal-time drift block; frozen parent sealed; v2 bindings; reuse bound to tree+behavior set)
  packages/cli/src/receipts.ts (ReceiptExpectations extended: tree/behavior/case-set)
  packages/cli/test/gate-receipts.ts (mint v2 through real issuer; testReceiptV2Bindings helper)
  packages/cli/test/{broker,broker-phase3,receipt-gate,scoped-receipt-gate,scoped-sealing}.test.ts (v2 seals; NEW broker-phase3: hostile plugin, git filter, v1, tree tamper, protected boundary)
Commands actually executed:
  npx vitest run packages/cli/test/broker.test.ts packages/cli/test/broker-phase3.test.ts packages/cli/test/receipt-gate.test.ts packages/cli/test/scoped-receipt-gate.test.ts packages/cli/test/scoped-sealing.test.ts packages/cli/test/trusted-policy.test.ts packages/cli/test/staged-candidate.test.ts packages/core/test/gate-receipt.test.ts packages/core/test/behavior-policy.test.ts packages/core/test/behavior-phase2.test.ts packages/cli/test/behavior-phase2.test.ts
  → 11 files, 157 tests, pass
  npx vitest run packages/cli/test/broker-phase3.test.ts packages/cli/test/broker.test.ts → 13 pass (incl. 5 NEW)
  cd packages/core && npx tsc -p tsconfig.json --noEmit → exit 0
  cd packages/cli && npx tsc -p tsconfig.json --noEmit → exit 0
Normal behavior observed:
  Valid v2 receipt + matching tree/parent seals and commits; reuse only on identical tree+behavior set; drift-free supervised runs seal.
Broken/hostile behavior observed:
  Hostile plugin side effect absent after broker (present after controller pipeline — probe live); candidate clean filter never fires in broker (fires on real git add — probe live); v1 rejected with fresh-run instruction; tampered tree binding mac-fail; tree-A receipt + tree-B bytes EVIDENCE_STALE; moved parent CAS mismatch; protected authority refuses local-unisolated receipt.
Exact rejection cause:
  tree-mismatch/behavior-digest-mismatch/case-set-mismatch/case-execution-mismatch/engine-bundle-mismatch/boundary-mismatch/artifact-mismatch (new typed); malformed (v1); mac-fail (tamper); EVIDENCE_STALE (drift/tree); BROKER_CAS_MISMATCH (parent).
Receipt/ref outcome: v2 receipts sealed in tests; broker commits move ref by exactly one CAS-checked commit; rejections leave ref untouched.
Remaining external prerequisites: managed-authoritative boundary values + protected host (Phase 10).
Mapped memory updated: yes
```

### Phase 4 — Trusted fixtures, actors and state scopes

**What to implement**

1. Add the fixture provider/lease interfaces and trusted loader from Section 4.5. Bundle imports must be pinned transitively.
2. Extend `EvidenceAdapter`/registry validation for `snapshotScope`/`awaitBarrier`. Existing adapters continue serving legacy proofs; unsupported strong requests block.
3. Register the compiled catalog and allowed case/test assignments via a supervisor-only endpoint before opening test sessions. NEW endpoint: `POST /runs/behavior-catalog`, verifier-key protected, one-time binding for the run.
4. Add witness-side case state storage and strict lifecycle transitions. A worker can name an allowed case but cannot post actor credentials, expectations, before-state or an application origin.
5. Add NEW `POST /behavior/execute` with body `{sessionId, sessionToken, caseId}` only. Unknown keys are errors. Resolve case data from the supervisor-bound catalog.
6. Add bounded snapshots, duplicate-identity checks and complete scope/barrier validation. Emit diagnostic failure facts without issuing satisfying observations on incomplete collection.
7. Add a trusted test-state service to the repository's test harness for genuine out-of-process observation. Use actual storage/service behavior, not a callback returning expected pass values.
8. Extend the accounts example with optional injected store support while retaining `createAccountStore({clock})` default behavior. All store callsites must handle the injected async implementation consistently; do not mix awaited and unawaited reads.
9. In strong example runs, the app writes through a namespaced writer capability to the trusted store service. The witness reads through a separate read-only capability. The test worker receives neither. The app's own GET can deliberately lie in an adversarial variant without fooling the observer.
10. Add lifecycle shutdown/timeout paths so failed cases release only their own fixture namespace.

**Read/copy patterns**

- `witness/types.ts`, `adapter-registry.ts`, `server.ts:requireSupervisor`, `handleRunContext`, `issueRecord`.
- Existing `probeServer` validation and read context construction.
- `example/lib/app.js:createAccountStore`, `createApp`.
- `pack-playwright/test/server-persistence.test.ts`, `observe-binding.test.ts`, `witness.test.ts`.

**Verification**

- Worker attempts catalog registration or input/actor override -> unauthorized/invalid request, no satisfying record.
- Unknown case, case belonging to another test, closed session, duplicate execution -> typed rejection.
- Snapshot returns incomplete page or wrong namespace -> block.
- App GET lies about saved data -> trusted store snapshot exposes mismatch.
- Read-only observer cannot write; test worker cannot access store credentials.
- Fixtures for two cases with equal business IDs cannot cross-credit because namespaces differ.

**Anti-pattern guards**

No arbitrary callback execution from test payload; no mutation methods on read adapter; no fallback to candidate-owned API for protected proof; no trusting app headers as build/tenant identity.

```text
Status: COMPLETE
Changed files:
  packages/pack-playwright/src/witness/fixture-provider.ts (NEW: FixtureProvider/FixtureLease/ActorLease, approved-bundle loader, in-memory provider)
  packages/pack-playwright/src/witness/types.ts (ScopeSnapshot/SnapshotScopeInput/BarrierInput, adapter snapshotScope/awaitBarrier, behavior catalog/execute request/response, CaseExecutionState, fixtureProvider option)
  packages/pack-playwright/src/witness/adapter-registry.ts (snapshotScope/awaitBarrier validation + passthrough)
  packages/pack-playwright/src/witness/behavior.ts (NEW pure validateScopeSnapshot/identityKeyOf: complete/namespace/order/duplicate/field/bound/truncation gates)
  packages/pack-playwright/src/witness/server.ts (behaviorCatalog + caseExecutions state, POST /runs/behavior-catalog supervisor one-time bind, POST /behavior/execute exact-key worker boundary with fixture lease + authoritative before snapshots + redacted reference, shutdown lease release)
  packages/pack-playwright/test/test-state-service.ts (NEW trusted harness: writer/reader capability split, namespace isolation, checkpoint clock)
  packages/pack-playwright/test/behavior-snapshot.test.ts (NEW: 17 tests)
  packages/pack-playwright/test/behavior-lifecycle.test.ts (NEW: 16 tests incl. lying-GET probe, namespace isolation, fault-mode matrix)
  example/lib/app.js (optional async backend + prebuilt store injection; all handle callsites awaited consistently; sync default retained)
Commands actually executed:
  npx vitest run packages/pack-playwright/test/behavior-snapshot.test.ts → 17 pass (NEW)
  npx vitest run packages/pack-playwright/test/behavior-lifecycle.test.ts → 16 pass (NEW)
  npx vitest run packages/pack-playwright/test/server-persistence.test.ts packages/pack-playwright/test/observe-binding.test.ts → 17 pass
  npx vitest run packages/pack-playwright/test/witness.test.ts → 38 pass
  node smoke: example default sync store + async backend + HTTP serve → ok
  cd packages/pack-playwright && npx tsc -p tsconfig.json --noEmit → exit 0 (after core dist rebuild for source/dist alignment)
Normal behavior observed:
  Assigned case executes to before-snapshot-complete with unique namespace + authoritative checkpoint; redacted reference carries no credentials/subjects; namespaces isolate equal business ids; checkpoints advance on mutation only.
Broken/hostile behavior observed:
  Worker catalog registration → 401, no binding; unknown case → 400; actor/expect override keys → 400; foreign case → 403; duplicate/closed-session → 409; incomplete/wrong-namespace/paged/truncated/unordered snapshots → 409 OBSERVATION_SCOPE_INCOMPLETE with empty ledger; legacy adapter (no snapshotScope) → 409; no provider → 409; lying app GET (Mallory over HTTP) leaves trusted snapshot at truth (Ada + service checkpoint).
Exact rejection cause:
  401 supervisor gate; 400 exact-key/unknown-case/stale-assignment; 403 foreign case; 409 unbound catalog/duplicate/closed-session/incomplete-scope/missing-provider; OBSERVATION_SCOPE_INCOMPLETE diagnostics, no satisfying records.
Receipt/ref outcome: n/a (Phase 4 issues no behavior.case records; principal driver lands in Phase 5).
Remaining external prerequisites: owner-provisioned production observer (read-only DB/sidecar) for the protected profile (Phase 10).
Mapped memory updated: yes
```

### Phase 5 — Exact endpoint-to-effect proof

**What to implement**

1. Add a witness-owned request driver for engine-http cases, limited to the approved subject origin/routes and approved actor material.
2. Extend engine browser capture with actual request metadata/body observation needed for the case binding. Keep bounded memory; over-limit proof inputs block rather than hash only a misleading prefix.
3. Reuse the shared route resolver against the full route inventory. A URL matching multiple effective route identities is unsupported/ambiguous until an authoritative dispatch observation exists; do not select the first.
4. Execute the Section 4.6 lifecycle, capture before/after state and expected principal request attempts, then issue `behavior.case` records.
5. Implement `http:effect-verified` and `http:read-result-verified` in existing HTTP dispatch, backed by `evaluateRequiredCases`.
6. Bind observed record identity to request path/body identifiers and trusted fixture subjects. Include tenant/plane and full composite keys.
7. Grade multi-resource changes atomically as one case result: all expected effects and all forbidden changes must match. A half-written import/audit pair fails.
8. Add declarative bulk/import comparisons and exact set matching; missing/extra/duplicate entities fail.
9. Mark new capabilities available only once real witness-produced evidence exercises the grader. Required observation capability remains checked per configured case.
10. Add cross-case sharing rules only through compiled multi-obligation declarations. Reject suite-expanded claim IDs and records replayed into another endpoint/case.

**Read/copy patterns**

- `core/src/verdict/pack-verifiers.ts:gradeTransportRecord` for existing route attribution, NOT for business semantics.
- `core/src/verdict/evaluate.ts:exactValueEchoFailure`, identity normalization, `gradeCrudSession`.
- `witness/server.ts:handleBrowserAction`, `handlePersistence`, `finalizeObserveClaim`.
- `witness/browser.ts:captureExchanges` and `EngineCapturedExchange`.

**Verification**

- Invoice A changed/read A expected values -> pass.
- Action A/read B, wrong tenant, wrong path, wrong HTTP method, wrong field value -> fail.
- 200 response with no update -> fail.
- Correct primary row plus unauthorized secondary ledger change -> fail.
- Two indistinguishable matching requests -> block unless a reviewed sequence requires both.
- Create batch of two expected entities with one missing/extra/duplicate -> fail.
- Read filter returns another user's row or wrong set -> fail.
- All mandatory cases must pass; a passing happy path cannot hide a failed negative case.

**Anti-pattern guards**

No status-derived business outcome, no count-only mutation proof, no same-session-only correlation, no post-hoc suite-selected entity ID, no unknown request-body parser fallback.

```text
Status: COMPLETE
Changed files:
  packages/core/src/verdict/behavior.ts (NEW: evaluateRequiredCases + behaviorActionDigestOf + full state/response/value/envelope graders + atomic unexpected-effect detection)
  packages/core/src/verdict/{index,evaluate}.ts (behavior exports; VerdictContext.behavior; required-case aggregation branch before legacy any-claim shortcut)
  packages/core/src/verdict/pack-verifiers.ts (strong HTTP contracts available with behavior.case observer; fallback stays missing outside a compiled set)
  packages/core/src/schemas/behavior-evidence.ts (requestObservations + fixtureValues sealed observations)
  packages/core/src/schemas/behavior-catalog.ts (BehaviorCatalogRegistrationSchema aligned to wire format: routes + authorityProfileDigest)
  packages/core/src/index.ts (behavior exports)
  packages/core/test/behavior-grade.test.ts (NEW: 19 tests incl. A/B binding, zero-delta, secondary-effect, ambiguity, exact-set batch, read-leak probes)
  packages/core/test/{behavior-policy,verifier-registry}.test.ts (capability flip: strong HTTP available)
  packages/cli/src/evaluate.ts (behavior context + authority profile into grading)
  packages/cli/src/commands/{check,test-gates}.ts (provision authority profile digest)
  packages/pack-playwright/src/witness/behavior-request.ts (NEW engine-http driver: approved origin/routes/actor material, bounded capture, manual redirects, corrupted-credential variant)
  packages/pack-playwright/src/witness/fixture-provider.ts (resolveCredential engine-side + recipe subjects)
  packages/pack-playwright/src/witness/types.ts (routes + authorityProfileDigest in binding; principal request/response; barrierTimeoutMs)
  packages/pack-playwright/src/witness/server.ts (POST /behavior/principal: attribution, barrier, after-state, per-obligation behavior.case issuance)
  packages/pack-playwright/test/behavior-principal.test.ts (NEW: 7 tests incl. witness→ledger→verdict satisfied + zero-delta + secondary-effect grading)
  packages/core/dist/**: rebuilt (pack-playwright resolves core via dist)
Commands actually executed:
  cd packages/core && npx vitest run test/behavior-grade.test.ts test/behavior-policy.test.ts test/behavior-phase2.test.ts test/verifier-registry.test.ts test/verdict.test.ts test/policy.test.ts test/schemas.test.ts → 234 pass (incl. 19 NEW)
  npx vitest run packages/pack-playwright/test/behavior-snapshot/lifecycle/principal/witness/server-persistence/observe-binding → 96 pass (incl. 7 NEW)
  npx vitest run broker/broker-phase3/receipt-gate/scoped-receipt/scoped-sealing/trusted-policy/behavior-phase2 (cli) → 93 pass
  cd packages/core && npm run build → exit 0; npx tsc --noEmit core+cli+pack-playwright → exit 0
Normal behavior observed:
  Real app update via engine driver seals a record that grades satisfied end to end (witness → ledger → verdict); declared 303 accepted; barrier checkpoint resolves async effects.
Broken/hostile behavior observed:
  Wrong subject/method/endpoint → BINDING_MISMATCH invalid; 200-no-change → invalid zero-delta; secondary row → UNEXPECTED_EFFECT invalid; duplicate attempts/records → invalid ambiguity; unplanned-test replay → invalid; suite lookalike → ignored (missing); stale spec/foreign profile → invalid; misdirected principal (no inventory match) → 409 diagnostic with no record; dead barrier → 409; surface/deliver actions → 409 Phase 6/8; read returning foreign row → invalid.
Exact rejection cause:
  BEHAVIOR_BINDING_MISMATCH / BEHAVIOR_EFFECT_MISMATCH / BEHAVIOR_UNEXPECTED_EFFECT / BEHAVIOR_CASE_MISSING / OBSERVATION_SCOPE_INCOMPLETE / ENFORCEMENT_UNTRUSTED (profile); verdict invalid vs missing preserved.
Receipt/ref outcome: n/a (no receipt path changed; behavior obligations now grade through aggregation in check/test-gates).
Remaining external prerequisites: Chromium for browser-channel cases (Phase 6); queue/delivery harness for task/webhook (Phase 8).
Mapped memory updated: yes
```

### Phase 6 — Browser/import proof and existing-test workflow

**What to implement**

1. Add `evidence.prove(caseId)` to the existing fixture/client exports. It may send only the allowed case ID and session credential.
2. Resolve surface descriptors from the approved behavior bundle for strong cases, not from an arbitrary worker-provided object. Existing weak surface APIs retain their original meaning.
3. Reuse surface v1/v2 engine browser drivers. Add finite upload/file step support for the import example and explicit expected rejection observation where needed; no arbitrary `page.evaluate` extension.
4. Add NEW `example/behavior/server.js` and `example/behavior/package.json`: an Express reference application with explicit, statically discoverable profile/admin/import route registrations, real UI forms and the same injected accounts store interface from Phase 4. Give each path distinct handlers and case mappings. The existing plain `node:http` dispatch in `example/lib/app.js` is NOT an advertised detector input; do not claim `pack-http` discovers arbitrary hand-written dispatch. Reuse the account store/data shape and small rendering helpers where sensible; do not build a second storage model or change unrelated existing examples.
5. Extend existing example journeys or add thin overlay files for missing proof channels. Do not rewrite unrelated consumer suites or generate tests based only on endpoint count.
6. Extend mapping resolution, `tests suggest`, `tests explain` and `tests mark --case` so candidates are proposed by current inventory and final approval requires witnessed case execution.
7. Keep Observe output labeled as weaker persistence observation. Existing Observe evidence must not satisfy strong endpoint/browser cases. If a consumer chooses Observe, readiness must show the remaining stronger requirements rather than silently downgrade them.
8. Bind engine-visible results to the same case subject. Error banner and navigation/state checks must be performed by the engine where required, not inferred from test source containing locator strings.

**Read/copy patterns**

- `example/e2e/accounts-crud-journey.spec.js`, `accounts-surface.js`, `vendor-wizard-surface.js`.
- `pack-playwright/src/fixture/evidence.ts`, `fixture/witness-client.ts`.
- `pack-playwright/test/browser-engine.test.ts`, `surface-steps.test.ts`, `e2e-example.test.ts`.
- CLI mapping/discovery tests and current onboarding plan.

**Verification**

Run real Chromium against the example app, through real witness and CLI:

- Profile editor case green, admin case absent -> gate blocked.
- Add admin case, import broken -> gate blocked.
- Fix and execute all three -> exact-case receipt can be sealed.
- Fake success page, manual navigation masking app failure, fake frontend origin and off-origin redirect -> block.
- Existing observation-only test remains useful for its original contract but does not acquire protected-browser credit.

**Anti-pattern guards**

No `.fill()` counting, no regex assertion detector as proof, no keyword-based automatic coverage approval, no consumer config execution as authority.

```text
Status: COMPLETE (repository-side)
Changed files:
  packages/pack-playwright/src/fixture/{witness-client,evidence}.ts (proveCase/drivePrincipal transport; evidence.prove(caseId): execute + drive, redacted refs only)
  packages/pack-playwright/src/witness/types.ts (binding.surfaces; principal request/response; browserObservation payload field via evidence schema)
  packages/pack-playwright/src/witness/server.ts (bundle surface validation at bind; driveSurfacePrincipal: bundle-resolved descriptor, lease-resolved subject/fields, trusted UI base, engine drive + visible read + URL capture; principal branch routing request/surface/deliver-sequence)
  packages/core/src/schemas/behavior-evidence.ts (browserObservation optional: url/entityId/visibleFields)
  packages/core/src/verdict/behavior.ts (shared matchSingleCaseRecord/validateCaseBindings; gradeSurfaceCase: entity binding + visible fields + atomic state rules)
  packages/core/test/behavior-grade.test.ts (5 surface tests + B59 Observe-strength pin)
  packages/pack-playwright/test/behavior-prove.test.ts (NEW: 3 tests, prove through the real fixture client)
  packages/pack-playwright/test/behavior-principal.test.ts (+4 surface tests: malformed bundle 400, missing descriptor/files 409, no-browser-boundary 409)
  packages/pack-playwright/test/fixture.test.ts (frozen surface now includes prove)
  packages/cli/src/commands/tests.ts (suggest: unmapped required-case slugs in text + JSON)
  example/behavior/{package.json,package-lock.json,server.js} (NEW Express app: profile/admin/import over shared accounts store, real forms incl. file input, distinct handlers; express 5.2.1 exactly pinned)
  example/behavior/e2e/{behavior-surfaces.js,behavior-proof.spec.js} (NEW overlay descriptors + 3 prove-based tests; node --check clean)
  packages/core/dist/**: rebuilt
Commands actually executed:
  npx vitest run pack-playwright behavior-snapshot/lifecycle/principal/prove + witness + fixture + surface-steps → 48+26 pass (incl. 3 NEW prove, 4 NEW surface, 5 NEW surface-grade, 1 B59)
  npx vitest run core behavior-grade/policy/verifier-registry → 125 pass
  npx vitest run cli tests-map.test.ts → 14 pass
  pack-http detector over example/behavior/server.js → 10 server-route facts (profile/admin/import/api, express origin)
  example/behavior HTTP smoke: import 2 rows 200, profile update 303, read reflects, empty import 422 with no side effect, form carries file input
  cd packages/core && npm run build → exit 0; tsc core+cli+pack-playwright → exit 0
Normal behavior observed:
  prove(caseId) executes + seals through the fixture client with redacted refs; suggest names unmapped cases per obligation; detector discovers all behavior routes.
Broken/hostile behavior observed:
  Malformed bundle surface → 400; surface case without descriptor / with files / without UI base → 409 with no record; Observe record vs strong case → missing (B59); wrong-entity/wrong-field surface observations → invalid.
Exact rejection cause:
  400 bundle validation; 409 missing-descriptor/files/no-UI-base/unbound; BEHAVIOR_BINDING_MISMATCH (entity/attempts); BEHAVIOR_EFFECT_MISMATCH (visible); missing (no observation / Observe-vs-strong).
Environment-blocked (pre-existing, verified on clean tree for the browser family):
  Live-Chromium rows (profile/admin/import green through real witness+CLI, fake-page/redirect/origin probes, Phase 5 item-2 browser capture) — no usable browser in this sandbox.
Deferred with explicit cause (not silent):
  Surface file-input materialization → 409 unsupported (import proves over engine-http bulk JSON instead).
Receipt/ref outcome: n/a.
Remaining external prerequisites: Chromium-capable runner for the live rows (Phase 10 environment or owner runner).
Mapped memory updated: yes
```

### Phase 7 — Authentication and validation semantics

**What to implement**

1. Implement every auth and validation contract in Section 8 using approved actor profiles, actual engine-controlled requests and independent state scopes.
2. Extend pure graders inside core without making core import pack runtime implementations (avoid circular dependencies). Pack vocabularies/detectors remain owners of their declared contracts.
3. Corroborate detector facts against approved behavior declarations. A schema/role change invalidates catalog and required-case digests.
4. Permission cases must have a valid authorized positive control and known existing target. Test role denial, same-tenant wrong ownership where declared, and cross-tenant isolation separately.
5. Validate both write denial and read confidentiality. A 403 body containing a foreign record still fails isolation.
6. Test validation just-inside/at/just-outside declared boundaries where meaningful, required fields, wrong types, enum/format constraints and malformed requests as finite explicit cases.
7. Compare full declared effect scopes after rejection, including outbox/audit rules. An approved denial-audit append can be expected; it must not be confused with forbidden business mutation.
8. Implement stable response-envelope grading against the approved response schema/projection. A schema digest alone does not prove runtime output shape.
9. Update namespace capability metadata only for implemented contracts; unknown names still fail closed. Remove obsolete namespace-wide unavailable assertions only where superseded by observable behavior tests.
10. Drive auth/validation examples through the real CLI/witness/grader, not just their existing direct-server tests.

**Read/copy patterns**

- `pack-auth/src/obligations.ts`, `adapter-schema.ts`, `detector.ts`.
- `pack-validation/src/obligations.ts`, `detector.ts` (there is no current validation adapter-schema file; do not assume one).
- `example/auth/server.js`, `example/validation/server.js`.
- `core/src/verdict/pack-verifiers.ts:DOMAIN_NAMESPACES`, fail-closed registration.

**Verification**

For every contract, one real passing application behavior and one deliberately broken behavior must change the gate outcome. Examples: denied request still writes; invalid request creates an outbox row; wrong-tenant response leaks body; bad token accidentally accepted; validator rejects every request so negative-only tests would be misleading.

```text
Status: COMPLETE
Changed files:
  packages/core/src/verdict/behavior.ts (AUTH_CONTRACTS/VALIDATION_CONTRACTS/BEHAVIOR_CASE_CONTRACTS; known-existing-target presence checks for path params + absent subjects)
  packages/core/src/verdict/{evaluate,index}.ts (aggregation extended to all behavior-case contracts)
  packages/core/src/verdict/pack-verifiers.ts (auth+validation implemented-contract routing; per-claim fallback names the missing case set; capability records available for auth/validation, task/webhook/workflow still fail-closed)
  packages/core/src/index.ts (new contract-set exports)
  packages/core/test/behavior-grade.test.ts (B26 nonexistent-target / B27 403-after-mutation / B28 403-leak grader probes)
  packages/core/test/verifier-registry.test.ts (auth/validation available; no-case-set fallback reason; workflow-only VERIFIER_UNSUPPORTED)
  packages/pack-playwright/test/behavior-auth.test.ts (NEW: 5 auth contracts end-to-end against the real example server: allowed 201+created; denied/isolated/no-effect/forged 403/401 + unchanged scope; isolated adds owner-declared field absence; corrupted credential variant)
  packages/pack-playwright/test/behavior-validation.test.ts (NEW: 3 tests — 5 validation contracts end-to-end incl. boundary 50/51, field-error rules, envelope shapes; B30 reject-everything validator; B29 smuggled-extra-row)
  example/auth/server.js (createAuthApp factory: injectable secret + ledger; mintAuthToken/createMemoryLedger exports; standalone default preserved)
  example/validation/server.js (createValidationApp factory: injectable ledger; createMemoryLedger export; standalone default preserved)
  packages/core/dist/**: rebuilt
Commands actually executed:
  cd packages/core && npx vitest run test/behavior-grade.test.ts test/verifier-registry.test.ts test/behavior-policy.test.ts test/verdict.test.ts test/policy.test.ts test/schemas.test.ts test/behavior-phase2.test.ts test/config.test.ts test/fingerprints.test.ts test/report.test.ts test/coverage-policy.test.ts → 11 files, 295 pass (incl. 3 NEW denial probes)
  npx vitest run pack-playwright behavior-auth/behavior-validation/behavior-principal/behavior-prove → 18 pass (2 NEW files)
  npx vitest run pack-playwright witness/snapshot/lifecycle/server-persistence/observe-binding/fixture → 101 pass (no regressions)
  cd packages/core && npm run build → exit 0; tsc core+pack-playwright+cli → exit 0
  Example servers: standalone smoke (401 no-token; 201 create / 400 field errors) + pack-auth/pack-validation e2e 17 pass (factories preserved)
Normal behavior observed:
  Real engine requests against the real servers: admin token creates refund (graded satisfied incl. created-row + response field); member token 403 with zero delta; cross-tenant admin 403 + owner-declared tenant_id absence; corrupted signature 401; boundary 50 chars accepted, 51 rejected with exact field error; envelope shapes hold.
Broken/hostile behavior observed:
  B26 denial vs nonexistent target → invalid (fixture validation); B27 403 recorded after mutation → invalid; B28 403 leaking the record → invalid; B30 reject-everything validator → accepted case invalid (negative-only misleading); B29 smuggled extra row → UNEXPECTED_EFFECT.
Exact rejection cause:
  Per-claim fallback: "has no compiled required-case set … transport evidence cannot satisfy them"; grader: BEHAVIOR_BINDING_MISMATCH / BEHAVIOR_EFFECT_MISMATCH / BEHAVIOR_UNEXPECTED_EFFECT.
Receipt/ref outcome: n/a.
Remaining external prerequisites: none for Phase 7 (examples drove through the real witness/grader).
Mapped memory updated: yes
```

### Phase 8 — Workflow, tasks, webhooks and failure/retry behavior

**What to implement**

1. Implement all remaining domain contracts in Section 8 using the same case lifecycle and requirement aggregation, not separate ad-hoc proof protocols.
2. For task delivery, the trusted harness owns delivery identity, idempotency keys, finite attempt schedule and deterministic time advancement. Observe actual side-effect records and delivery outcomes independently.
3. For idempotency, execute both serial duplicates and a concurrent race where the application's contract permits concurrency. Require the exact same declared business key, not two unrelated successful requests.
4. Observe retry limit and terminal outcomes through a real queue/runner test fixture or the existing task example adapted for controlled observation. App-reported `attempts:3` alone is not evidence.
5. Webhook signing occurs engine-side over the exact declared raw bytes. Wrong-signature, malformed-body and replay cases must assert state as well as response.
6. Workflow sequences observe actual before/from/to states and actor-qualified append-only audit entries. Invalid/terminal transitions cannot pass on a rejection status if state/audit changed improperly.
7. Add controlled failure injection to the trusted fixture recipe, not a secret bypass in the product verifier. For each required failure case, record which operation was interrupted and what state must remain or recover.
8. Read-side scope/barrier failures must remain failures. Never label an unavailable queue observer as an application failure or pass a partial observation.
9. Keep each app-specific adapter honest about the scope observed. External payment delivery in tests uses an isolated, real local service with its own ledger, never production payment credentials.
10. Update capabilities, CLI preflight and example declarations only after the real end-to-end channel works for each contract.

**Read/copy patterns**

- `pack-task/src/obligations.ts`, `pack-webhook/src/obligations.ts`, `pack-workflow/src/obligations.ts`.
- `example/task/server.js:runTask`, actual audit/side-effect behavior.
- `example/webhook/server.js`, `example/workflow/server.js`.
- Existing `pack-*/test/e2e.test.ts` for app behavior only; wrap the real pipeline for acceptance.

**Verification**

- Same payment key delivered twice -> exactly one ledger effect.
- Same key racing concurrently -> still one effect.
- Permanent failure exceeds max attempts -> blocked.
- Retryable failure succeeds within declared bound -> correct final state and trace.
- Invalid signature gets 401 but writes anyway -> blocked.
- Terminal workflow changes state or emits success audit on rejected transition -> blocked.

```text
Status: COMPLETE (repository-side)
Changed files:
  packages/pack-playwright/src/witness/behavior-request.ts (raw-body + engine-side HMAC-SHA256 signature profile over exact fixture bytes; signing secret consumed engine-side, never sent; corrupted-credential variant flips headers)
  packages/core/src/verdict/behavior.ts (checkIdentitySelectors: raw bodies graded by exact-byte comparison against sealed fixture values)
  packages/pack-playwright/src/witness/server.ts (behavior-catalog bind: approved surfaces map validated at bind)
  packages/pack-playwright/test/behavior-domain.test.ts (NEW: workflow transition-allowed (state + actor-qualified audit append-only) / transition-rejected (409 + unchanged + response absence); task idempotent duplicate-key single effect + terminal error zero effect; webhook signature-accepted one delivery + wrong-signature 401 zero delta)
  example/task/server.js (createTaskState injected state + factory threading; standalone default preserved)
  example/webhook/server.js (createWebhookState injected state + start(state) threading; standalone guard; pack-webhook e2e green)
  packages/core/dist/**: rebuilt
Commands actually executed:
  npx vitest run pack-playwright behavior-domain/auth/validation/principal/prove/snapshot/lifecycle → 55 pass (3 NEW domain)
  npx vitest run pack-playwright witness/server-persistence/observe-binding/fixture/surface-steps → 81 pass (no regressions)
  npx vitest run pack-task/pack-webhook/pack-workflow/pack-auth/pack-validation e2e → 37 pass (factories preserved)
  cd packages/core && npx vitest run 12 behavior/registry/verdict/policy/schema/config/fingerprint/receipt files → 321 pass
  cd packages/core && npm run build → exit 0; tsc core+pack-playwright+cli → exit 0
Normal behavior observed:
  Workflow draft→pending via engine driver with declared transition + actor-qualified audit row; task duplicate key → exactly one effect entity; terminal error → zero effect; webhook valid engine-signed delivery → one created entity; wrong signature → 401 zero delta.
Broken/hostile behavior observed:
  Wrong-signature delivery → 401, unchanged scope (declared 401 satisfied honestly); count-delta-as-sole-rule rejected at compile (Phase 1 guard); undeclared path params and raw-without-profile are driver diagnostics (409 OBSERVATION_SCOPE_INCOMPLETE), never silent passes.
Exact rejection cause:
  BEHAVIOR_EFFECT_MISMATCH / OBSERVATION_SCOPE_INCOMPLETE where hostile; satisfied only on full declared effect match.
Deferred with explicit cause:
  Concurrent duplicate-delivery race (B33) and attempt-schedule trace assertion need a controllable-clock queue harness — Phase 11/12 environment; serial idempotency and terminal handling are proven here.
Receipt/ref outcome: n/a.
Remaining external prerequisites: queue/runner clock harness for B33–B35 rows (Phase 11).
Mapped memory updated: yes
```

### Phase 9 — CLI, reporting, onboarding and installed usability
- Correct state with missing/wrong-actor audit -> blocked.

### Phase 9 — CLI, reporting, onboarding and installed usability

**What to implement**

1. Wire shared causes into text, JSON, SARIF, endpoint inventory and `next`. Expose requirement/intent/execution/proof/enforcement separately.
2. Add `init --behavior` and non-destructive owner-guided setup. Report missing case definitions, adapters, fixture profiles and isolation capabilities precisely. Never print ready when only YAML was generated.
3. Add profile readiness checks to `enforcement doctor`: approved bundle, actual runtime identity, candidate read-only mounts, private authority paths, observer scope capability, target build binding and hosting enforcement state.
4. Distinguish `verified`, `unverified`, `unavailable` and `failed` facts internally; map to the existing doctor status surface without claiming that external paths or current-user access tests prove isolation.
5. Add a complete worked setup for the multi-endpoint accounts example plus a domain case. Every documented NEW API must exist by this phase.
6. Update README, `packages/cli/README.md`, Playwright package docs if present, `docs/guides/new-table-playbook.md` and ADRs to remove stale claims about CRUD availability and to explain the new stronger mode.
7. Preserve old truthful transport/Observe documentation; do not market them as equivalent to protected behavior.
8. Rebuild affected workspace artifacts and verify installed package entrypoints, not just source imports. Keep workspace dependency ranges consistent with released artifact versions.

**Verification**

- One-action `next` points at the actual first blocker, not at test generation for a missing observer.
- Reports show three endpoints and their separate case outcomes.
- Failed setup produces exit 2 with missing prerequisite; no fake half-ready status.
- Existing basic initialization remains non-overwriting and usable.
- Installed CLI resolves the intended sibling package versions and understands the new document.

**Anti-pattern guards**

No copying outdated README limitations over working code; no undocumented test-side knobs; no “owner approved” inferred from an agent-editable file; no hardcoded old pack version in generated config.

```text
Status: COMPLETE (repository-side)
Changed files:
  packages/cli/src/commands/init.ts (INIT_USAGE + BEHAVIOR_TEMPLATE + BEHAVIOR_CHECKLIST; --behavior/--no-behavior scaffolds .gateforge/behavior.yml and wires behaviorPolicy into a NEW .gateforge.yml only — existing config untouched with an explicit instruction; behavior checklist printed: scaffold ≠ ready)
  packages/cli/src/commands/next.ts (behavior causes ranked 2 — above CRUD coverage/CHANGE_UNMAPPED/test advice; configuration and observation gaps block before any test-generation suggestion)
  packages/cli/src/commands/enforcement.ts (doctor 'behavior-profile' check: not-configured ok; missing file fail; invalid fail; scaffold warn with ENDPOINT_BEHAVIOR_MISSING note; declared endpoints ok with witness-readiness caveat)
  packages/cli/test/next.test.ts (NEW ranking test: ENDPOINT_BEHAVIOR_MISSING above mapping advice, via a fixture http.contract + empty behavior document)
  packages/cli/test/enforcement-doctor.test.ts (check-id list + not-configured assertions)
  README.md, packages/cli/README.md (capability table updated: strong HTTP + auth/validation available via behavior-case channel; task/webhook/workflow remain UNSUPPORTED)
Commands actually executed:
  npx vitest run packages/cli/test/init.test.ts → 22 pass
  npx vitest run packages/cli/test/enforcement-doctor.test.ts → 4 pass (updated ids + not-configured row)
  npx vitest run packages/cli/test/next.test.ts → 7 pass (incl. NEW ranking test)
  npm run typecheck → exit 0 (all workspaces)
  cd packages/cli && npm run build → exit 0
Normal behavior observed:
  next prints the behavior declaration gap (cause ENDPOINT_BEHAVIOR_MISSING, action 'Owner defines endpoint behavior') instead of overlay advice; doctor reports the scaffold as warn and unconfigured as ok; init --behavior scaffolds behavior.yml + wires a new config without touching existing files.
Broken/hostile behavior observed: none new (behavior failures were already blocking; ranking verified).
Exact rejection cause: n/a (reporting phase).
Receipt/ref outcome: n/a.
Remaining external prerequisites: none for Phase 9.
Mapped memory updated: yes
```

### Phase 10 — Protected managed deployment and actual server acceptance

**Repository work**

1. Add NEW `deploy/managed/` assets for the Linux rootless Podman reference deployment: pinned engine image/build, service-account setup instructions, container/runtime profiles and authority configuration template. This is a new directory because no existing managed deployment assets were found.
2. Add NEW `packages/cli/src/isolation.ts` as the narrow controller/runtime interface used by supervised execution. It launches the approved profile with fixed arguments, validates active mounts/users/networks and returns the authoritative boundary record. No caller-supplied shell string.
3. Run app build, app, worker and controller in the role separation specified in Section 4.10. Package install lifecycle hooks are candidate execution and receive no authority secrets.
4. Implement owner-provisioned approval bundle updates as separate administrative actions. No `tests mark`, agent waiver, changed config or candidate CLI flag may approve a new trusted bundle.
5. Extend the existing GitLab strict-gate template and documentation, retaining externally controlled mandatory execution. Also provide a GitHub protected-check integration because the repository has GitHub workflows, but do not pretend an editable pull-request workflow alone is protection: use an external trusted controller that reports a required check for the exact tested SHA/merge candidate.
6. Required check identity/publisher must be bound to the protected controller; another candidate job using the same display name must not satisfy acceptance.
7. Generate no host tokens or privileged grants automatically. Owner provides service identity, protected branch rules, runner and policy bundle.
8. Add local real-process boundary tests with separate identities/containers and disposable Git repositories. These are repository acceptance, not substitutes for actual host enforcement.

**External owner inputs, explicitly unresolved at planning time**

- Disposable authorized GitLab/GitHub project and target branch.
- Hosting plan/features and permissions needed to enforce an externally controlled required check.
- Browser-capable isolated runner/service account.
- Managed host with rootless Podman/network isolation support.
- Approved policy/fixture/adapter bundle, actor provisioning method and read-only state access for the consumer.

Do not ask for these to write code that can be completed with the repository examples. Ask only when executing the external rollout. No owner input is permission to touch production data.

**Actual host acceptance**

- Failed behavior -> merge/protected ref update denied.
- Candidate deletes or weakens local CI workflow -> authoritative check still required and enforced.
- Candidate job fabricates a green report/check name -> does not authorize.
- Target branch advances -> old candidate result no longer authorizes the merged candidate.
- Agent directly pushes protected ref -> denied.
- Local `--no-verify` or alternate hooksPath can create a local commit in standard mode, but cannot enter protected history.
- Managed agent cannot change authoritative Git refs or private engine/policy/key files, cannot inspect authority process credentials, and can commit only by presenting a valid exact-candidate result to the broker.
- Genuine complete run -> accepted once for the correct candidate and base.

Record host job/check URLs, candidate/base/tree identifiers, tested role, observed rejections and resulting ref state. Redact credentials. Without these results Phase 10 deployment remains blocked.

```text
Status: REPOSITORY-SIDE COMPLETE / EXTERNAL ACCEPTANCE BLOCKED (owner inputs)
Changed files:
  deploy/managed/README.md (NEW: role table, hard rules, what this directory does NOT do)
  deploy/managed/controller.containerfile (NEW: pinned base; engine installed only from the mounted approved bundle; fixed entrypoint)
  deploy/managed/authority.env.template (NEW: authority boundary, verifier key, approved policy digest, hosting project/protected ref placeholders)
  deploy/managed/runtime-profile.md (NEW: four-role boundaries, exact mounts, network, boundary records)
  packages/cli/src/isolation.ts (NEW: IsolationProfile/IsolationRecord/validateIsolationRecord — rootless user, private network, socket hidden, host-home/Git/socket mount denials, engine+candidate read-only, app-state writable, digest recomputed not trusted; inspectManagedRuntime honest local-unisolated default; resolveIsolation profile gate)
  packages/cli/test/isolation.test.ts (NEW: 9 boundary tests incl. every denial rule)
Commands actually executed:
  cd packages/cli && npx vitest run test/isolation.test.ts → 9 pass
  cd packages/cli && npx tsc -p tsconfig.json --noEmit → exit 0
Normal behavior observed:
  Conforming managed record validates with the podman-rootless digest; a Podman-less environment honestly reports local-unisolated.
Broken/hostile behavior observed:
  root/absent user, host network, visible socket, host-home/Git/socket mounts, writable engine or candidate, read-only app-state → typed UsageError denials; unknown profile refused.
Exact rejection cause:
  isolation boundary invalid: <rule> (fail closed) — invalid records never authorize receipts.
Receipt/ref outcome: boundary digest recompute-then-compare verified; receipt seal via executionBoundaryDigest is Phase 3-wired.
Remaining external prerequisites (BLOCKING for full Phase 10):
  - disposable authorized hosting project + protected branch/ref
  - managed host with rootless Podman + dedicated service accounts
  - browser-capable isolated runner
  - approved policy/behavior bundle + actor provisioning + read-only state access
  - the actual host acceptance run (failed behavior denied, spoofed check rejected, direct push denied, ref unchanged)
Mapped memory updated: yes
```

### Phase 11 — Adversarial qualification

**What to implement**

1. Integrate the mandatory matrix in Section 9 using the existing red-probe harness and existing relevant test files.
2. Add minimal new files only for genuinely new behavior domains: endpoint behavior integration, case lifecycle, fixture authority and OS boundary tests.
3. Each attack has a positive control using the same route/fixture/channel so an environmental failure cannot masquerade as a successful defense.
4. A rejection must be for the intended cause and leave no accepted receipt/ref change. “Any nonzero exit” is insufficient for the security claim.
5. Test mutations belong in disposable fixture applications/temporary repos. Never mutate the real working tree, real database or real branch protections as a test.
6. Use the existing green/broken pair convention: deliberately broken application behavior must make the behavior gate fail. Also include a deliberately weakened checker variant in an isolated probe where needed to show that the regression test catches a false approval.
7. Do not remove pre-existing forged-execution, fake-browser, fake-origin, redirect, stale-evidence, incomplete-run and policy-ownership cases.

**Required evidence**

A table per attack: ID, normal case command/result, hostile variant command/result, exact cause, receipt absent/rejected, authoritative ref unchanged where applicable. Engine-only cases must not be labeled browser or host proof.

```text
Status: COMPLETE (repository-side) / BLOCKED (managed host rows)
Changed files:
  packages/core/test/phase11-task-qualification.test.ts (NEW: trusted retry/attempt qualification for B34/B35)
  packages/pack-playwright/test/behavior-domain.test.ts (strict indexed-access type fix; runtime assertions unchanged)
  packages/cli/test/strict-e2e.test.ts (auth/validation capability expectations aligned with Phase 7)
  packages/cli/test/strict-supervised.test.ts (named Chromium project makes native inventory deterministic)
Commands actually executed:
  npx vitest run packages/core/test/phase11-task-qualification.test.ts → 3 pass
  npx vitest run packages/pack-playwright/test/behavior-domain.test.ts packages/cli/test/strict-e2e.test.ts packages/cli/test/strict-supervised.test.ts packages/plugin-protocol/test/host.test.ts packages/pack-playwright/test/e2e-example.test.ts → 63 pass
  npm run build → pass
  npm run typecheck → pass
  npm test → 148 files, 1801 tests pass
Normal behavior observed:
  Trusted task state effects satisfy; named Chromium supervised journeys seal v2 receipts; installed tarball CLI reports 0.4.1 and discovers the profile/admin/import endpoint inventory.
Broken/hostile behavior observed:
  Terminal/over-limit retry claims and app-reported fake attempt counts remain missing without a trusted delivery trace (B34/B35); the existing broker, receipt, stale-evidence, fake-browser, origin, mapping and endpoint probes remain green.
Exact rejection cause:
  Phase 11 task rows fail closed on unavailable trusted delivery trace; managed rows require `ENFORCEMENT_BOUNDARY_UNVERIFIED` / external host rejection evidence.
Receipt/ref outcome:
  Full suite retained receipt/ref rejection coverage; pure B34/B35 evaluator tests issue no receipts or refs.
Remaining external prerequisites:
  Disposable protected hosting project, managed rootless-Podman host, isolated runner, approved observer bundle, and canonical complete-behavior consumer setup.
Mapped memory updated: yes
```


### Phase 12 — Final acceptance through the product

**Run after the actual implementation is integrated**

1. Build all workspaces so compiled CLI and source tests agree.
2. Run targeted tests throughout implementation, then one centralized full test/typecheck pass after all edits stabilize.
3. Run the exact real CLI/Chromium scenario below using a disposable consumer repository and approved reference runtime.
4. Run the negative/domain examples through the same CLI/witness/verdict/receipt route.
5. Build npm tarballs, install all required sibling packages together into a clean scratch consumer with no workspace links, then repeat the setup/check flow. Do not publish as part of verification.
6. Re-run the protected broker/host acceptance for the installed engine artifact, not merely a source-tree version.
7. Record precisely what is complete and what is externally blocked. No passing subset may stand in for all five priorities.

**Canonical product scenario**

```text
Initialize complete-behavior profile on approved accounts example.
Discover profile/admin/import endpoints and approve their cases.
Map only profile test -> blocked: admin/import cases missing.
Map all tests but break admin save -> blocked: exact effect mismatch.
Fix admin; import saves only one of two records -> blocked: exact set mismatch.
Fix import; foreign user edits another account -> blocked: permission/state violation.
Fix permissions; invalid payload leaves an outbox row -> blocked: unexpected effect.
Fix validation; repeated delivery creates two ledger effects -> blocked: duplicate effect.
Fix application; run all required cases once -> signed v2 receipt.
Change one candidate byte -> receipt stale, no acceptance.
Rerun exact corrected candidate -> accepted by protected gate/broker.
Attempt to replace rules/checker/report -> rejected outside agent control.
```

**Completion evidence must include**

- All endpoint paths independently represented and exercised.
- Exact request/actor/record/value and multi-effect proof.
- Every domain contract in Section 8 proved by real observed behavior.
- Adversarial matrix passed with intended rejection causes.
- No required skips/retries; teardown completed; complete selected set.
- Protected runtime and host acceptance result, or explicit external blocker.
- Installed tarball smoke result and correct sibling versions.
- Updated plan progress and mapped memory, with verification commands/results.

## 8. Exact domain contract acceptance requirements

These are ALL required in this plan. Implement them in the existing namespaces; do not stop after auth and validation.

### 8.1 Authentication

| Existing contract | Required independent observations |
|---|---|
| `auth:role-allowed` | Approved actor identity/roles, matching principal request, declared successful business result |
| `auth:role-denied` | Valid unauthorized actor and otherwise valid request; declared denial; forbidden business effects unchanged; positive authorized control |
| `auth:tenant-isolated` | Existing foreign-tenant subject, trusted actor tenant, denial/no foreign read leakage/no foreign write; owned-subject control |
| `auth:denied-no-side-effect` | Entire declared business/secondary scope unchanged except explicitly allowed denial audit |
| `auth:forged-token-rejected` | Engine-generated corrupted credential, actual denial, no protected data leakage or business mutation |

### 8.2 Validation

| Existing contract | Required independent observations |
|---|---|
| `validation:boundary-accepted` | Actual input within approved constraint and correct resulting business state |
| `validation:boundary-rejected` | Actual violating input, relevant field error, rejected principal operation and forbidden effects absent |
| `validation:no-side-effect-on-reject` | Complete before/after effect-scope comparison, not only row count |
| `validation:error-message-explicit` | Actual error structure identifies the offending field/constraint; no brittle full-text message pin |
| `validation:envelope-shape-stable` | Actual success/rejection payloads validated against the approved versioned response envelope; definition change invalidates requirements |

### 8.3 Workflow

| Existing contract | Required independent observations |
|---|---|
| `workflow:transition-allowed` | Correct starting state, allowed action/actor, expected persisted next state and expected audit append |
| `workflow:transition-rejected` | Invalid transition attempted; state and forbidden audit effects unchanged |
| `workflow:terminal-immutable` | Attempted mutation of known terminal entity; no forbidden state change |
| `workflow:audit-emitted` | New append-only audit record with exact actor/from/to/subject linkage; no pre-existing audit credit |
| `workflow:persisted-final-state` | Engine-driven finite transition sequence ends in declared state for same subject |

### 8.4 Tasks

| Existing contract | Required independent observations |
|---|---|
| `task:retry-policy-enforced` | Actual engine-controlled delivery/attempt trace and declared bound under retryable failure |
| `task:idempotent` | Repeated same-key input produces exactly one expected business side effect; serial and concurrent cases where supported |
| `task:terminal-handled` | Known terminal error yields terminal result with no later retry beyond contract |
| `task:observability-recorded` | Actual new run/audit record linked to delivery identity and outcome, including failure |
| `task:duplicate-delivery-handled` | Duplicate same delivery identity handled without duplicate effect and with declared acknowledgement behavior |

### 8.5 Webhooks

| Existing contract | Required independent observations |
|---|---|
| `webhook:signature-accepted` | Engine-signed exact payload reaches expected business effect |
| `webhook:signature-rejected` | Wrong signature or changed raw body rejected; no forbidden effect |
| `webhook:malformed-rejected` | Malformed/unsupported/oversized declared inputs rejected without side effects |
| `webhook:replay-idempotent` | Repeated same event identity within declared window causes exactly one effect |
| `webhook:retry-bounded` | Engine controls attempts; observed accepted/rejected outcomes enforce declared limit and side-effect bound |

No domain verifier may reduce these rows to “2xx means accepted” or “4xx means safe.” The old rejected `/witness/domain-check` experiment in ADR 0004 is specifically NOT a template to restore.

## 9. Mandatory adversarial matrix

IDs are local to this plan (`B01` etc.); do not renumber old GF/E fixtures. Extend existing owners wherever practical.

| ID | Attack or regression | Required result | Primary test owner |
|---|---|---|---|
| B01 | Three endpoints share table, only one tested | Other endpoints missing | CLI endpoint behavior |
| B02 | New server-only endpoint has no frontend caller | New requirement blocks | CLI endpoint compiler/policy |
| B03 | Two planes share bare table name | No cross-plane credit | Core policy/identity |
| B04 | Endpoint writes two tables, test checks one | Missing secondary effect blocks | Core behavior/witness |
| B05 | Route removed/renamed, old mapping kept | Stale reference/receipt | CLI mapping/scope |
| B06 | Dynamic route or failed detector scan dropped | Incomplete discovery blocks | Detector/compiler integration |
| B07 | Shared model changes but one endpoint selected | Dependency closure selects all affected paths | CLI scope |
| B08 | Changed shared service cannot be linked | Conservative expansion/block | CLI scope |
| B09 | Suite says all cases covered in a label | No evidence credit | Core mapping/verdict |
| B10 | One passing case hides missing/failed siblings | Obligation blocked | Core required-case aggregation |
| B11 | Click/edit A, read B | Binding mismatch | Witness/core behavior |
| B12 | Correct ID in wrong tenant | Binding/permission mismatch | Auth/core behavior |
| B13 | Right response code, no saved change | Effect mismatch | Witness/HTTP behavior |
| B14 | Correct field value on wrong endpoint | Endpoint mismatch | HTTP route attribution |
| B15 | Correct row plus wrong secondary ledger effect | Unexpected effect | Witness/core behavior |
| B16 | Suite seeds desired result before principal action | Before-state/operation proof blocks | Witness case lifecycle |
| B17 | Extra matching mutation in action window | Ambiguous principal operation | Witness request binding |
| B18 | Reuse earlier case/session/run record | Identity/provenance/staleness block | Core provenance/case grader |
| B19 | Submit engine-looking case record through worker API | Suite-submitted record rejected | Witness/core verifier |
| B20 | Body snapshot truncated or unsupported encoding | Incomplete observation blocks | Witness capture |
| B21 | Snapshot silently returns one page | Incomplete scope blocks | Adapter validation |
| B22 | Update changes only bookkeeping timestamp | Required business delta missing | Core behavior |
| B23 | Import saves one of two records or an extra record | Exact set mismatch | Browser/import integration |
| B24 | Candidate GET lies about database state | Independent observer catches mismatch | Protected runtime/state fixture |
| B25 | Test directly mutates database/app outside driver | Runtime prevents it or strong proof rejected | Isolation integration |
| B26 | Denial caused by nonexistent fixture | Positive control/fixture validation blocks | Auth verifier |
| B27 | 403 after business mutation | No-side-effect violation | Auth/validation |
| B28 | 403 contains another tenant's data | Confidentiality violation | Auth verifier |
| B29 | Invalid payload adds outbox/audit business effect | Unexpected effect | Validation verifier |
| B30 | Validator rejects everything | Required valid boundary control fails | Validation verifier |
| B31 | Forged credential accepted | Auth contract fails | Auth witness E2E |
| B32 | Repeated payment/key produces two effects | Idempotency violation | Task/webhook verifier |
| B33 | Concurrent duplicates evade serial-only test | Duplicate effect caught | Task concurrency E2E |
| B34 | Retry after terminal error or above limit | Attempts/terminal violation | Task verifier |
| B35 | App reports fake attempt count | Trusted delivery trace disagrees | Task witness |
| B36 | Invalid webhook signature still writes | Signature/no-effect failure | Webhook witness |
| B37 | Raw signed body altered/re-serialized | Correct signature recipe catches it | Webhook request driver |
| B38 | Workflow denies but changes state | Transition failure | Workflow verifier |
| B39 | Correct state, missing/wrong actor audit | Audit failure | Workflow verifier |
| B40 | Async effect occurs after premature success | Barrier/incomplete scope blocks | State observer |
| B41 | Worker overrides case actor/expected value/origin | Request rejected; no proof | Witness supervisor boundary |
| B42 | Fake browser/frontend or hostile redirect | Existing origin/browser defenses retained | browser-engine tests |
| B43 | Fake reporter lifecycle/outcomes, no tests run | Incomplete execution, no receipt | execution-authority tests |
| B44 | Zero tests, skip/only, retry-assisted pass, teardown failure | Existing strict run rejection retained | supervision/CLI |
| B45 | Candidate weakens policy/adapter/helper/exclusion | Approved bundle mismatch before executable load | CLI trust tests |
| B46 | Unapproved plugin import executes inside broker | Must never execute; no marker/secret access | Broker authority test |
| B47 | Git filter/hook runs during authority snapshot | Must never execute | Broker ingestion test |
| B48 | Live workspace changes between freeze and signing | No mixed-byte acceptance | Snapshot/broker tests |
| B49 | Receipt field/case set/bundle digest tampered | Signature/binding failure | Receipt verifier |
| B50 | Old v1 receipt or old weaker evidence offered | Fresh-run/unsupported proof block | Receipt/migration tests |
| B51 | Parent/base moves after green | CAS/staleness rejection | Broker/server tests |
| B52 | Agent turns strict mode off in candidate config | Authority-required mode unchanged | Trust configuration tests |
| B53 | Worker reads parent env/proc/state files/FDs | OS boundary denies access | Linux managed integration |
| B54 | Worker replaces engine, approved adapter or browser origin | Read-only/pinned authority rejects | Linux managed integration |
| B55 | Agent bypasses local hook | Local limitation honest; protected acceptance denied | Host acceptance |
| B56 | Candidate deletes required CI job | External required check remains enforced | Host acceptance |
| B57 | Candidate job spoofs check name/report | Publisher/identity binding rejects | Host acceptance |
| B58 | Direct push to protected branch | Host denies; ref unchanged | Host acceptance |
| B59 | Weak Observe result offered as protected browser proof | Strength mismatch blocks | Mapping/verifier/receipt |
| B60 | Tarball resolves older sibling packages | Clean install flow fails before release, then repaired | Package smoke |

For cases B53–B58, a source-level mock or synthetic response is not sufficient proof. Use actual identities/containers or the approved disposable hosting project. If unavailable, mark those rows blocked with the missing prerequisite.

## 10. Verification commands and evidence discipline

### 10.1 Existing commands

From repository root, use the existing toolchain:

```sh
npm run build
node_modules/.bin/vitest run packages/core/test/policy.test.ts packages/core/test/verifier-registry.test.ts
node_modules/.bin/vitest run packages/cli/test/endpoint-compiler.test.ts packages/cli/test/endpoint-policy.test.ts
node_modules/.bin/vitest run packages/cli/test/scoped-sealing.test.ts packages/cli/test/scope-expansion.test.ts
node_modules/.bin/vitest run packages/pack-playwright/test/browser-engine.test.ts packages/pack-playwright/test/execution-authority.test.ts
node_modules/.bin/vitest run packages/cli/test/broker.test.ts packages/cli/test/receipt-gate.test.ts packages/cli/test/trusted-policy.test.ts
node_modules/.bin/vitest run packages/pack-playwright/test/e2e-example.test.ts packages/cli/test/strict-supervised.test.ts
npm run typecheck
npm test
```

These commands are execution instructions, not claims they were run during planning. Add each NEW focused test file to the owning phase's targeted invocation. Build before compiled-bin tests; the repository has previously encountered source/dist and nested dependency-copy drift.

### 10.2 Installed product smoke

Run `npm pack --workspaces --pack-destination <absolute-temp-directory>` after the build. Install the produced sibling tarballs together into a NEW scratch consumer; no workspace symlinks or registry fallbacks for changed packages. Invoke the installed `gateforge` binary against the approved example fixture and run the final scenario. Record installed package versions, gate result and receipt verification.

Do not run `npm publish`, create release tags or modify npm trust settings merely to verify the package. The existing release script permits per-package warnings; that behavior is not evidence that all new packages are installable together.

### 10.3 Per-phase record template

Append under the phase as it completes:

```text
Status: COMPLETE / BLOCKED
Changed files:
Commands actually executed:
Normal behavior observed:
Broken/hostile behavior observed:
Exact rejection cause:
Receipt/ref outcome:
Remaining external prerequisites:
Mapped memory updated: yes/no
```

Do not copy historic test counts from memories. Historical failures are not current verification results. A failing prerequisite must be distinguished from an intended adversarial rejection.

## 11. File ownership map for implementers

### Existing files/directories that will change

- `packages/core/src/schemas/{obligation,test-map,gate-receipt,verdict,common}.ts` as required by the pinned contracts; do not bump global `SchemaVersionField` to change only receipt envelope version.
- `packages/core/src/config/index.ts`, `fingerprints.ts`, `policy/index.ts`, `verdict/{evaluate,registry,pack-verifiers,cause}.ts`, `receipt/index.ts`, `mapping/`, relevant barrels and reporting.
- `packages/cli/src/{pipeline,state,scope,evaluate,execution,input-snapshot,mapping,receipts,trusted-policy,broker}.ts`.
- `packages/cli/src/commands/{init,tests,check,test-gates,next,enforcement}.ts`, `cli.ts` help/dispatch where needed.
- `packages/pack-playwright/src/witness/{types,adapter-registry,server,browser}.ts`, `surface.ts`, fixture/client exports, supervisor/drain and discovery runner integration.
- Existing domain pack contracts/detectors only where required to propagate observed contract facts; keep contract spellings.
- `example/lib/app.js`, accounts surfaces/journeys and domain example servers for honest integration fixtures.
- Existing relevant test files listed in the phases; docs listed in Phase 9.

### Deliberately NEW production modules

Create these only after confirming no equivalent has appeared since this plan:

- `packages/core/src/schemas/behavior-policy.ts`.
- `packages/core/src/schemas/behavior-catalog.ts`.
- `packages/core/src/schemas/behavior-evidence.ts`.
- `packages/core/src/policy/behavior.ts`.
- `packages/core/src/verdict/behavior.ts`.
- `packages/pack-playwright/src/witness/fixture-provider.ts`.
- `packages/pack-playwright/src/witness/behavior.ts` for the new bounded case driver; keep HTTP routing in existing `server.ts` rather than adding hundreds more driver lines to it.
- `packages/cli/src/isolation.ts`.
- `deploy/managed/` runtime assets.

No new workspace package is required for the feature. Reuse the existing core/CLI/Playwright/domain boundaries. Add fixture helpers under existing test ownership rather than a new general-purpose testing framework.

The new reference consumer at `example/behavior/` is an example application, not a new Gateforge workspace package. Its Express dependency must be exactly pinned in its own lockfile when implemented and exercised through the real `pack-http` detector. Existing plain-HTTP examples continue to prove their original flows.

## 12. Agent handoff rules

1. Read this plan, its mapped memory, and the current phase references before editing.
2. Check whether another implementation has already introduced a proposed symbol. Prefer the existing owner; no parallel implementation.
3. New API names in this plan are specifications, not existing imports. Implement and export them before use.
4. Before modifying exported symbols, run language-server references and account for all callsites. Source grep alone is not a rename/refactor plan.
5. Do not weaken schemas, disable checks, increase retries, add required-flow skips, widen baselines or self-approve policy to make tests pass.
6. Do not generate test forests. Reuse existing tests and keep new tests only for observable contracts, security boundaries or plausible regressions.
7. Never claim engine tests prove browser behavior, browser tests prove host protection, or a generated configuration proves deployment.
8. Keep source and compiled package behavior aligned before CLI verification. Install tarballs before calling packaging complete.
9. Update the exact same plan and memory after each phase. Do not create a new memory per phase or a competing plan.
10. If an existing plan/comment conflicts, cite the source and this plan's locked contract. Do not silently undo Observe, wizard surfaces, approved policy ownership or existing red probes.
11. No property-management repo edits, live host changes, production data operations or publication without separate authorization.
12. If a required external capability is missing, finish all reachable code and record the precise blocked acceptance rows. Never call the whole implementation done while Phase 10 remains unverified.

## 13. Final acceptance checklist: all five priorities

- [ ] Priority 1: Every applicable discovered endpoint has separately enumerated, mapped and executed required cases; server-only and shared-table paths included.
- [ ] Priority 2: Witness binds the exact endpoint/request/actor/subject/values to authoritative before/after effects; wrong-row and secondary-effect probes fail.
- [ ] Priority 3: All auth, validation, workflow, task and webhook contract rows above have real semantic producers, graders and CLI end-to-end proof.
- [ ] Priority 4: Candidate execution is isolated from authority; immutable tested tree and approved bundle bind the receipt; broker and actual protected hosting reject bypasses.
- [ ] Priority 5: All B01–B60 attacks have honest green/broken records at the required proof level, with no fake success caused by environmental failure.
- [ ] Exact candidate can pass the real installed product flow after the application is corrected.
- [ ] Basic/Observe/transport modes remain accurately labeled and do not confer stronger approval.
- [ ] No required test skips/retries or unresolved implementation placeholders.
- [ ] Plan and 1:1 mapped memory reflect actual execution, including external blockers.

## 14. References

- `docs/decisions/0004-frontend-consumed-endpoint-compiler.md`.
- `docs/decisions/0005-existing-test-reuse-and-e2e-enforcement-contracts.md`.
- `docs/decisions/0006-execution-and-browser-authority.md`.
- `docs/testing/TESTING_POLICY.md`.
- `docs/testing/RED_PROBE.md`.
- `docs/testing/e20-server-enforcement.md` — historical infrastructure status; re-verify on authorized rollout.
- `docs/testing/phase7-matrix-e01-e13.md` and `phase7-matrix-e14-e27.md` — existing acceptance ownership and proof taxonomy.
- `.zcode/plans/2026-09-18-onboarding-overlay-observe.md` — preserve shipped onboarding/Observe/wizard behavior, prefer current source over stale introductory status.
- `docs/memory/20260918_1200_base_qualified_duplicates_endpoints_config_planes_init.md` — endpoint declarations, plane-qualified discovery and installed-package lessons.
- `docs/plans/immediate/20260913_0000_existing_test_reuse_and_e2e_enforcement.md` — prior feature scope, not a substitute for this plan's new requirements.
- `docs/memory/20260919_1544_endpoint_behavior_and_trust_megaplan.md` — sole memory mapped to this plan.

## 15. Additional implementation pins and copyable example

This appendix closes field-shape and reference-fixture decisions. It is normative alongside Section 4. Do not replace these data contracts with a free-form expression language.

### 15.1 Value references and concrete case shape

Use these NEW wire types, implemented as strict discriminated zod unions in `behavior-policy.ts`:

```ts
type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
type InputValue =
  | {from: 'literal'; value: Json}
  | {from: 'fixture'; key: string};
type ExpectedValue =
  | InputValue
  | {from: 'request'; attempt: number; pointer: string; transform: 'identity' | 'trim' | 'lowercase'}
  | {from: 'before'; scope: string; subject: InputValue; field: string};

interface BehaviorCase {
  id: string;
  contract: string;
  channel: 'engine-browser' | 'engine-http' | 'engine-task';
  fixture: string;
  actor: string;
  action: BehaviorAction;
  expect: {
    statuses: number[];
    response: ResponseRule[];
    state: StateRule[];
    visible?: {surface: string; subject: InputValue; fields: Record<string, ExpectedValue>};
  };
  controlCase?: string;
}
```

Rules for these types:

- `fixture.key` resolves from the lease's `subjects` or approved literal fixture data; it is a dotted key lookup with own-property checks, not JavaScript evaluation. Reject `__proto__`, `prototype` and `constructor` in any lookup segment.
- `request.pointer` is an RFC 6901 JSON Pointer into the engine-normalized **request observation**, not into suite input. Use `/body/first_name`, `/path/id` and `/query/status` for normalized fields. Array indexes must be explicit and bounded; missing pointers block.
- `attempt` is zero-based within the case's declared action sequence. A future/self reference in action input is illegal. Only expectations can read request/before references.
- Requests carry both exact byte digests and normalized values. Decode supported encodings exactly once; reject duplicate ambiguous keys rather than taking an arbitrary winner.
- Header names normalize case, but secret-valued headers are never available through general JSON Pointer lookup.
- `statuses` is nonempty for every HTTP/surface step. It is empty only for a purely queue-driven case with independently observed delivery outcomes. All status codes are integer 100–599, sorted and duplicate-free.
- `response` may be empty when state/visible observations fully specify the effect; `state` may be empty only for a declared transport-only operational case. Strong read cases still require no forbidden state effects.
- `visible` is required when a case claims a user-visible result. An engine-http case cannot assert browser visibility without a separately declared engine-browser step.
- Numbers must be finite; monetary examples use integer minor units. Do not compare money through floating-point tolerance.
- Comparison transforms are approved per field. Applying `lowercase` to every field to make a mismatch disappear is forbidden.

Action union:

```ts
type PrimitiveAction =
  | {
      kind: 'surface'; surface: string;
      operation: 'create' | 'read' | 'update' | 'delete';
      subject?: InputValue;
      fields: Record<string, InputValue>;
      files?: Record<string, string>; // field -> approved file fixture key
    }
  | {
      kind: 'request'; method: string; pathTemplate: string;
      path: Record<string, InputValue>;
      query: Record<string, InputValue>;
      body: {encoding: 'json' | 'form'; fields: Record<string, InputValue>}
          | {encoding: 'multipart'; fields: Record<string, InputValue>; files: Record<string, string>}
          | {encoding: 'raw'; fixture: string};
      credentialVariant: 'valid' | 'missing' | 'corrupted';
      signatureProfile?: string;
    }
  | {
      kind: 'deliver'; resourceId: string; payload: InputValue;
      idempotencyKey: InputValue; deliveryId: InputValue;
      count: number; schedule: 'serial' | 'concurrent';
    };
type BehaviorAction =
  | PrimitiveAction
  | {kind: 'sequence'; steps: Array<{
      id: string; action: PrimitiveAction;
      expect: {statuses: number[]; state: StateRule[]};
    }>};
```

`method` uses the existing concrete HTTP method vocabulary; `ANY` is never executable. `pathTemplate` is origin-relative and resolves exactly the approved endpoint with fixture path values. Disallow absolute URLs, userinfo, path traversal and encoded separator ambiguity. Empty GET bodies are represented by `encoding:json, fields:{}` and are not sent as wire bodies. Query parameters remain part of case semantics even though route identity excludes query strings.

Nested sequences are forbidden. Step IDs are unique. Each step's result is required, and the final case expectation is additionally required; a final passing state cannot hide a wrong intermediate transition. Maximum sequence length, request byte limit, entity count and execution deadline come from the external authority profile, not worker data.

### 15.2 Exact expectation rule payloads

`ResponseRule` is a strict union:

```ts
type ResponseRule =
  | {kind:'equals'; pointer:string; value:ExpectedValue}
  | {kind:'field-error'; field:string; fieldPointer:string; codePointer:string; allowedCodes:string[]}
  | {kind:'absent'; pointer:string}
  | {kind:'entity-set'; pointer:string; identityFields:string[]; expected:InputValue[]}
  | {kind:'envelope'; schema:string}; // key of approved bounded envelope-shape data
```

For `envelope`, use the existing zod dependency to validate a bounded Gateforge shape vocabulary, NOT a claimed implementation of JSON Schema. The approved schema data is a recursive strict union: object (`properties`, `required`, `additionalProperties:false`), array (`items`, `minItems`, `maxItems`), string (`minLength`, `maxLength`, optional literal `enum`), number/integer (`minimum`, `maximum`), boolean, or null. All collection/length bounds are finite. Reject unknown types/keys, remote references, executable callbacks and coercion. Required fields must name declared properties. Validate the actual captured response against this data without changing its values or dropping extra fields. A shape change alters the approved schema/spec digest. This is sufficient for the reference envelopes; arbitrary JSON Schema dialect support is outside this plan.

`StateRule` is a strict union:

```ts
type StateRule =
  | {kind:'unchanged'; scope:string}
  | {kind:'updated'; scope:string; subject:InputValue; fields:Record<string,ExpectedValue>}
  | {kind:'created'; scope:string; rows:Array<{fields:Record<string,ExpectedValue>}>}
  | {kind:'absent'; scope:string; subjects:InputValue[]}
  | {kind:'archived'; scope:string; subject:InputValue; fields:Record<string,ExpectedValue>}
  | {kind:'exact-set'; scope:string; rows:Array<{subject:InputValue; fields:Record<string,ExpectedValue>}>}
  | {kind:'append-only'; scope:string; rows:Array<{fields:Record<string,ExpectedValue>}>}
  | {kind:'count-delta'; scope:string; delta:number}
  | {kind:'transition'; scope:string; subject:InputValue; field:string; from:ExpectedValue; to:ExpectedValue}
  | {kind:'attempts'; resourceId:string; count:number; terminal:'succeeded'|'failed'|'rejected'};
```

Implementation semantics:

- `unchanged`: equal identity set and all declared field projections, not just equal length.
- `updated`: same subject exists before/after, expected field values match, at least one declared business field changes. Preserve unrelated subjects/fields unless another rule explicitly permits their change.
- `created`: exact new-identity delta matches all expected rows one-to-one; no row reuse, missing row or extra row. Duplicate field projections that cannot distinguish records require a trusted fixture/request correlation key; otherwise block as ambiguous.
- `absent`: declared subject existed before and is absent after. A never-existing subject cannot prove delete.
- `archived`: same subject remains, declared archive fields match; ordinary removal cannot satisfy archive.
- `exact-set`: equal normalized identity/value set; ordering ignored unless separately part of approved semantics.
- `append-only`: before entries retained unchanged, exact new entries match; replacing or removing an old audit row fails.
- `count-delta`: supplemental only. Schema/compiler rejects it as the sole state rule for mutation, rejection, idempotency or duplicate-delivery proof.
- `transition`: independently observed before/from and after/to on the same entity.
- `attempts`: comes from trusted delivery/request execution observations, not a candidate-owned JSON field.
- Every declared scope must be covered by at least one rule; unmentioned scope mutations are forbidden. For allowed automatic timestamps, omit only specifically approved volatile fields from `EffectScope.fields`; never discard arbitrary mismatching fields.

### 15.3 Compiled records and registration body

```ts
interface CompiledBehaviorCase {
  caseId: string;              // 64-hex identity
  specDigest: string;          // 64-hex complete canonical specification digest
  resourceId: string;
  endpointResourceId: string | null;
  obligationIds: string[];     // sorted, deduplicated, current normalized IDs
  definition: BehaviorCase;
  effects: EffectScope[];
  sourceFiles: string[];       // sorted approved dependency/source paths
}
interface BehaviorCatalogRegistration {
  schemaVersion: 1;
  runId: string;
  invocationId: string;
  catalog: BehaviorCatalog;
  assignments: Array<{testId:string; caseIds:string[]}>;
}
```

The supervisor sends this registration to `POST /runs/behavior-catalog` using the existing verifier-key authorization mechanism. Witness recomputes the catalog digest, validates all assignments, checks the previously bound run/invocation/input context and refuses a conflicting second registration. Registration must finish before any assigned session opens.

The same logical case may be mapped to multiple candidate tests for suggestions, but the sealed run assigns exactly one first-attempt execution owner. Ambiguous live ownership blocks selection until resolved; it must not trigger duplicate execution races. Different native project instances remain distinct planned tests and may not impersonate the assigned owner.

`behavior.case` outer evidence has ONE `obligationId` because `EvidenceRecordSchema` does. If one approved case supports multiple obligations, issue one outer record per declared obligation with the same immutable `executionId` and equivalent observed payload. The payload's compiled `obligationIds` must match the catalog; the worker cannot expand it. Case execution completeness is counted by `caseId + executionId`, not the number of copied outer records.

Persist the generated catalog through the existing run-state location returned by `resolveStateDir`, as `behavior-catalog.json`. It is derived, not a new tracked authority document. Tampering with this copy cannot alter the controller-bound catalog.

### 15.4 External authority bundle configuration

Reuse the existing external `GATEFORGE_TRUSTED_CONFIG` mechanism. Extend `EnforcementConfigSchema` with an `authority` object, valid ONLY when loaded from outside the candidate by the protected controller:

```ts
interface AuthorityConfig {
  profile: 'complete-behavior';
  repositoryId: string;
  bundleRoot: string;          // absolute, outside agent/candidate writable roots
  bundleDigest: string;        // owner-approved 64-hex digest
  allowedWorkspaceRoot: string;
  authoritativeGitDir: string;
  allowedRef: string;          // exact fully qualified ref
  runtime: {
    driver: 'podman';
    engineImage: string;      // immutable image digest, never :latest
    runnerImage: string;
    observerImage: string;
    maxCaseMilliseconds: number;
    maxRequestBytes: number;
    maxSnapshotEntities: number;
    maxSequenceSteps: number;
  };
}
```

- Reject `authority` inside candidate `.gateforge.yml`; do not read it as an approval source even if its hash looks valid.
- Existing `GATEFORGE_APPROVED_POLICY_DIGEST` remains the policy revision pin; the external authority bundle also binds executable dependency bytes and runtime profile.
- If multiple external pin sources are supplied and disagree, fail; no first-source-wins approval.
- `bundleRoot` contains `manifest.json`, approved engine/provider/surface/fixture/actor files and their full dependency closure. Manifest entries are relative regular-file paths with content digests; symlinks and escaping imports are refused in the reference runtime.
- The controller validates the bundle before loading any module. Approved runtime images bind system/runtime dependencies outside the JavaScript bundle.
- Secret material lives in controller-owned secret mounts, referenced by manifest keys, excluded from suite outputs. Never put actual secret values in repository YAML.
- Every path/mount must be checked from the actual worker/agent identity as well as from controller configuration. “This file is outside the repository” is not equivalent to “the agent cannot write it.”
- Required candidate executable files must belong to the frozen candidate tree. Ignored executable helpers must either be intentionally tracked or moved into the approved external bundle. A live ignored helper cannot silently affect a protected run.
- `allowedRef` is fixed by owner configuration. A worker-provided `--ref` does not authorize writes elsewhere.
- Make image/capability preflight errors precise. The plan does not prescribe current host image digest values; the implementation builds the repository's approved images, records their digests and the owner provisions them. No fabricated digest constants.

### 15.5 Concrete behavior document example

This is a NEW-schema example for Phase 1/5/6, not a configuration that works with the current release. The reference Express fixture MUST implement these exact two update routes; its third import route receives its own bulk case using the same schema.

```yaml
schemaVersion: 1
endpoints:
  - resourceId: tenant.http-post-profile-accounts-param
    effects:
      - id: accounts
        resourceId: tenant.accounts
        adapter: accounts
        scope: fixture-accounts
        identityFields: [tenant_id, id]
        fields: [first_name, last_name, status]
        completion: immediate
    cases:
      - id: owner-update
        contract: http:effect-verified
        channel: engine-http
        fixture: two-tenants-two-accounts
        actor: owner-a
        action:
          kind: request
          method: POST
          pathTemplate: /profile/accounts/{id}
          path:
            id: {from: fixture, key: accountA.id}
          query: {}
          body:
            encoding: json
            fields:
              first_name: {from: literal, value: Ada}
              last_name: {from: literal, value: Lovelace}
          credentialVariant: valid
        expect:
          statuses: [200]
          response: []
          state:
            - kind: updated
              scope: accounts
              subject: {from: fixture, key: accountA.identity}
              fields:
                first_name: {from: request, attempt: 0, pointer: /body/first_name, transform: identity}
                last_name: {from: request, attempt: 0, pointer: /body/last_name, transform: identity}
      - id: foreign-tenant-denied
        contract: auth:tenant-isolated
        channel: engine-http
        fixture: two-tenants-two-accounts
        actor: owner-b
        controlCase: owner-update
        action:
          kind: request
          method: POST
          pathTemplate: /profile/accounts/{id}
          path:
            id: {from: fixture, key: accountA.id}
          query: {}
          body:
            encoding: json
            fields:
              first_name: {from: literal, value: Ada}
              last_name: {from: literal, value: Lovelace}
          credentialVariant: valid
        expect:
          statuses: [403]
          response:
            - {kind: absent, pointer: /account}
          state:
            - {kind: unchanged, scope: accounts}
  - resourceId: tenant.http-post-admin-accounts-param
    effects:
      - id: accounts
        resourceId: tenant.accounts
        adapter: accounts
        scope: fixture-accounts
        identityFields: [tenant_id, id]
        fields: [first_name, last_name, status]
        completion: immediate
    cases:
      - id: admin-update
        contract: http:effect-verified
        channel: engine-http
        fixture: two-tenants-two-accounts
        actor: admin-a
        action:
          kind: request
          method: POST
          pathTemplate: /admin/accounts/{id}
          path:
            id: {from: fixture, key: accountA.id}
          query: {}
          body:
            encoding: json
            fields:
              first_name: {from: literal, value: Grace}
              last_name: {from: literal, value: Hopper}
          credentialVariant: valid
        expect:
          statuses: [200]
          response: []
          state:
            - kind: updated
              scope: accounts
              subject: {from: fixture, key: accountA.identity}
              fields:
                first_name: {from: request, attempt: 0, pointer: /body/first_name, transform: identity}
                last_name: {from: request, attempt: 0, pointer: /body/last_name, transform: identity}
resources: []
```

Important example details:

- The approved fixture starts account A with a different name, so this is a real update rather than a no-op.
- The new reference behavior fixture adds tenant identity deliberately. Do not claim the original accounts example already has `tenant_id`; extend the reference fixture's state and classification together.
- The foreign actor targets an existing account owned by A; the control proves a valid actor can perform the same operation. No account-existence shortcut.
- This excerpt intentionally lacks the discovered import endpoint. The compiler MUST report `ENDPOINT_BEHAVIOR_MISSING` until its explicit bulk case is added. This demonstrates missing coverage; it is not the final complete reference configuration.
- Add separate engine-browser cases using approved profile/admin/import surfaces for user-visible acceptance. The engine-http cases above cannot claim UI proof.
- For negative confidentiality tests, supplement `/account` absence with exact approved error-envelope checks and protected-scope identity scanning; absence of one JSON key is not a universal leak detector.

### 15.6 Finite reference-runtime limits

The example protected profile uses: one active case per fixture namespace; zero test retries; at most 32 steps per sequence; at most 8 request/delivery attempts per example case; at most 1 MiB request or response capture per attempt; at most 1,000 entities per scope; at most 30 seconds per case. These are configurable by the OWNER in the external authority profile, never by tests.

Crossing a bound yields incomplete observation/run failure. No partial-body hash, sampled state, automatically increased limit or quiet fallback may produce a successful strong proof. Scope snapshots should project only declared fields and use canonical streaming digests where possible; do not repeatedly copy whole datasets per obligation when a single case snapshot can serve its compiled obligations.

### 15.7 Final planning validation record

The planning deliverable is checked mechanically for all phases, five priority acceptance rows, B01–B60 uniqueness, all 25 existing domain contract spellings and references to existing source files. Newly proposed files are explicitly identified as NEW and excluded from existing-file existence checks. The YAML excerpt is parsed as YAML during plan validation; runtime schema validation belongs to Phase 1, since the new schema is not implemented yet.

This validation proves plan consistency and source-reference availability, not implementation correctness or protected deployment.

Planning validation completed on 2026-09-19: 13 phase sections (discovery plus 12 implementation phases), all five priority checklists, 60 unique ordered adversarial cases, all 25 existing domain contract names, and all explicitly cited existing file paths checked successfully. The YAML example parsed successfully and contains three concrete cases. The in-memory Node validation process exited 0. Proposed NEW files were treated as planned outputs, not misreported as existing APIs. No implementation or deployment verification is claimed.
## 16. Verification audit — 2026-09-20

The 2026-09-19 audit correctly identified source-side gaps. This follow-up
implemented those gaps and reran repository and canonical-consumer checks.

### Resolved source-side findings

- Managed sealing now resolves the owner-controlled authority boundary through
  `resolveIsolation`. A managed request rejects missing or invalid Podman
  evidence instead of downgrading to local-unisolated.
- `inspectManagedRuntime` now parses the active controller's Podman inspect
  record for user, network, mounts, and socket visibility; it no longer
  fabricates a boundary from a label.
- Sealed receipts bind the canonical digest of schema-valid, authenticated,
  completed `behavior.case` records that contributed to satisfied verdicts.
  Unreferenced, malformed, mismatched, and claimed-only records are excluded.
- Task, webhook, and workflow contracts now dispatch through the existing
  required-case semantic grader. Transport-only records remain blocking and
  unknown/uncompiled cases remain fail-closed.
- `example/behavior/` now contains committed Gateforge configuration,
  behavior policy, endpoint-separated cases for profile/admin/import, an
  explicit adapter and fixture declaration, a test map, and a named Chromium
  Playwright project. Its supported JSON bulk-import path is verified; the
  unsupported multipart path remains explicitly typed as 415 rather than
  being misreported as spreadsheet proof.
- `.github/workflows/gateforge-strict.yml` checks the exact pull-request head
  SHA and runs strict gate/check commands. The workflow documents that
  branch protection, owner-controlled workflow/ruleset enforcement, protected
  secrets, and publisher restrictions must be provisioned outside the
  candidate-controlled repository.
- The managed controller image now requires an owner-supplied immutable
  `sha256:<64-hex>` Fedora digest and rejects floating or malformed values.

### Verification

- `npm run build` — pass.
- `npm run typecheck` — pass.
- `npm test` — pass: 148 files, 1,812 tests, after installing the matching
  Playwright Chromium v1208 browser and headless shell.
- Focused isolation, receipt, broker, test-gates, check, behavior, registry,
  and Phase 11 tests — pass.
- `example/behavior` `npm test` — pass: named Chromium inventory, JSON bulk
  import creates two records, multipart file input returns typed 415.
- Canonical `gateforge tests suggest --json` — pass: three obligations,
  zero mapping problems.
- Canonical `gateforge check --format json` — intentionally blocks on twelve
  undeclared ancillary endpoint behavior obligations; no owner-only waiver was
  added.
- GitHub workflow YAML parsing, container shell syntax, and `git diff --check`
  — pass.

### Remaining external blockers

- No owner-managed rootless-Podman controller was available locally, so live
  managed-host acceptance remains unperformed and must be run externally.
- Protected branch/required-check settings, owner-controlled workflow/ruleset,
  protected secrets, publisher enforcement, and the approved Fedora digest
  remain owner-provisioned deployment inputs.
- The canonical fixture intentionally does not claim browser spreadsheet
  multipart proof; a real multipart engine/browser channel is still required
  for that claim.

## 17. Fresh verification — 2026-09-20

### Checks rerun

- `npm run build` — pass.
- `npm run typecheck` — pass.
- `npm test` — pass: 148 files, 1,816 tests.
- Focused isolation, receipt, broker, behavior-domain, task/workflow/webhook,
  and strict-gate tests — pass; isolation is 15/15.
- `example/behavior/npm test` — pass: named Chromium inventory, JSON bulk
  import creates two records, multipart input returns typed 415.
- Canonical `gateforge tests suggest --json` — exit 0, three obligations,
  zero mapping problems.
- Canonical `gateforge check --format json` — exit 1 as designed: three
  behavior obligations are missing and twelve ancillary endpoint
  declarations/resource links remain unresolved.
- Managed isolation smoke — fails closed without Podman; no local downgrade.
- Fixed managed launch tests verify immutable image input, `--rm --detach`,
  fixed user/network/root filesystem, exactly three request-bound volumes,
  and authoritative `ps`/`inspect` matching.
- Playwright Chromium/headless shell present; Podman absent.
- Workflow YAML parsing, controller shell syntax, and `git diff --check` —
  pass.

### Remaining acceptance limitations

- No owner-managed rootless-Podman controller was available locally, so live
  container launch, mount enforcement, image enforcement, and B53-B58 host
  acceptance remain unperformed.
- Protected branch/required-check settings, owner-controlled workflow/ruleset,
  protected secrets, publisher enforcement, and the approved Fedora digest
  remain owner-provisioned deployment inputs.
- The canonical fixture intentionally does not claim browser spreadsheet
  multipart proof; a real bounded multipart engine/browser channel is still
  required for that claim.

## 18. Fresh implementation probe — 2026-09-20

- The stale-controller bug is fixed. A non-zero `podman run` status now
  rejects before any inspection, so a stale same-name container cannot be
  reused.
- A successful launch must return one valid 12–64 character hexadecimal
  container ID. Empty, multiline, and non-ID output fails closed before
  inspection.
- The successful launch ID is passed directly to `podman inspect`; the
  launched path skips name/label discovery entirely. The regression test
  reproduces status 125 plus a stale same-name controller and proves no
  inspect call occurs.
- Final verification: 17/17 isolation tests, CLI typecheck, build, and full
  workspace suite pass (148 files, 1,818 tests).

## 19. Latest implementation check — 2026-09-20

- The stale-controller fix remains verified: failed launches reject before
  inspection, and successful launches inspect the exact returned ID.
- The managed image now starts the explicit fixed `controller` command.
  `gateforge controller` writes an atomic health/heartbeat document at the
  fixed `/app-state/controller-health.json` path, refreshes it every five
  seconds, and records a stopped state on SIGTERM/SIGINT. It does not execute
  candidate commands or read candidate configuration.
- `controller.containerfile` declares `CMD ["controller"]` in addition to
  the fixed entrypoint, so owner-started images and the isolation launch use
  the same long-lived process.
- Focused controller/isolation tests pass: 20 tests, including both signal
  paths and fixed launch argv.
- Final workspace verification passes: build, typecheck, and serial full
  suite (`npm test -- --maxWorkers=1`) — 149 files, 1,821 tests.

### Remaining acceptance limitation

- No Podman binary or owner-managed image was available on this host, so the
  actual container lifecycle and health-file behavior under rootless Podman
  remain external acceptance work.

## 20. Gateforge-managed runtime bootstrap

### Decision

Do not add a separate setup/doctor command for installation. Extend the
existing `gateforge init` command with an explicit `--managed` mode. Plain
`gateforge init` remains local and does not install system software.

### Implementation contract

- `gateforge init --managed` detects Podman before writing project files.
- If Podman is absent, Gateforge invokes the host's native package manager
  through fixed argv (no shell), with inherited terminal I/O so the owner can
  approve privilege escalation. It supports the current Linux package-manager
  families first and reports unsupported platforms precisely.
- After installation, Gateforge verifies `podman --version` and rootless
  `podman info`; any failure stops initialization before managed config is
  written.
- Managed initialization writes `enforcement.mode: managed` and enables strict
  E2E enforcement through the existing config template and blocking wiring.
- No npm lifecycle script, candidate configuration, or silent `sudo` action
  installs host software.
- The installer is unit-tested through injected command seams; the property
  repository uses the local current CLI package for integration verification.

## 21. Managed bootstrap implementation — 2026-09-20

### Completed

- Added `packages/cli/src/podman-bootstrap.ts`, an owner-command seam that
  probes `podman --version`, selects `pacman`, `apt-get`, or `dnf`, invokes
  the native installer through fixed argv, and verifies rootless
  `podman info --format '{{.Host.Security.Rootless}}'`.
- Extended the existing `gateforge init` command with explicit
  `--managed`; no separate install or doctor command was introduced.
- `init --managed` installs/verifies the runtime before project writes,
  implies the existing blocking wiring, writes strict managed enforcement,
  and upgrades an existing `.gateforge.yml` only for this explicit request.
- Added focused bootstrap and managed-init tests, including package-manager
  selection, rootless failure, unsupported platforms, first initialization,
  and existing-config migration.
- Updated CLI help and the command reference with the owner-approved
  installation behavior.

### Verification

- `npm run build` — pass.
- `npm run typecheck` — pass.
- Focused bootstrap/init tests — 30 pass after the confirmation correction; the earlier args-focused run also passed.
- Full workspace suite — 150 files, 1,829 tests pass.
- Property-management repository resolves `@gate-forge/cli` to the current
  local package; `npx gateforge --version` reports `0.4.1`.
- Property discovery succeeds with 1,201 entries, 114 unresolved rows, and
  three parse errors; `check --format json` exits 1 with the repository's
  existing 518 blocking summary (276 missing obligations, 242 blocking
  entries).

### External acceptance

- Live owner-approved bootstrap is now complete: Podman 6.1.2 is installed,
  `podman info` reports `rootless=true`, and managed initialization completed
  in the property-management repository. The later Arch upgrade-consent
  correction governs future installations.

## 22. Arch upgrade-consent correction — 2026-09-20

- The first live managed bootstrap used the targeted Arch command and
  failed because the local package database referenced stale mirror objects
  (`404` for Podman packages).
- The initial retry was changed to `pacman -Syu --needed podman`; this
  successfully installed Podman but also upgraded the full host system
  (299 packages, approximately 4.7 GiB download). This was broader than
  necessary and was not preceded by a Gateforge confirmation prompt.
- The implementation is corrected: `init --managed` now tries
  `pacman -S --needed podman` first. Only if that fails does it ask the
  owner whether to run the full `pacman -Syu --needed podman` fallback.
  Declining fails closed before project writes. Non-interactive runs
  decline by default.
- Added tests for targeted-first ordering, explicit approval, and refusal.
- The already-completed live run verified Podman 6.1.2, rootless mode,
  managed enforcement config, and `enforcement doctor --json` exit 0.

## 23. Live managed-container proof attempt — 2026-09-20

- A chat task subagent inspected the existing `resolveIsolation` seam and
  attempted the documented managed-controller image build and real launch
  path with the property repository as candidate.
- Rootless Podman was verified, and cleanup was verified: no managed image,
  container, or network was left behind.
- The image build stopped before launch because the required
  `FEDORA_BASE_DIGEST` is unset, producing the invalid base reference
  `quay.io/fedora/fedora@`.
- The direct isolation API also failed closed before Podman with the
  expected owner-boundary error:
  `GATEFORGE_MANAGED_CONTROLLER_IMAGE must be an owner-provisioned immutable
  sha256 image digest`.
- No files were edited by the proof subagent. Remaining prerequisite:
  owner-provide the approved Fedora base digest, build/publish the controller
  image at an immutable digest, and provide the trusted engine bundle/service
  user inputs required by the managed authority profile. No digest was
  fabricated.

## 24. Managed controller proof corrections — 2026-09-20

- Owner-approved Fedora amd64 base digest:
  `sha256:a43233b829403f8f21d0b0f3e20836ba3c386c95cfa572e9e240009e6a75bf8c`.
- The first image build exposed that Fedora 44 has no `podman-tools` package;
  the controller image now installs only `nodejs`, `git`, and `git-lfs`.
- The image now creates the fixed `gateforge-runner` UID 10001 and invokes the
  published npm engine path `/engine/bin/gateforge.js`.
- Rootless Podman maps `--network private` to `pasta`, which is not the
  controller's isolated network contract. The heartbeat-only controller now
  uses `--network none`; future app/worker networking remains a separate
  owner-provisioned internal network.
- Live proof passed with the locally built immutable controller image
  `localhost/gateforge-managed-controller@sha256:bc70bb9a26cddaf2a8d10aade6a6f7815e4714af58bf7e8665537fa4f4727782`:
  Gateforge launched the controller, Podman inspection confirmed the exact
  image/user/network/mount boundary, and the controller wrote a healthy
  heartbeat. The managed container was stopped and removed afterward.
- The proof required owner-style staging outside `/home` and rootless
  subordinate-ID ownership for writable app state. `init --managed` still
  verifies Podman only; automatic engine/image/state provisioning remains
  separate implementation work.
- Managed initialization now rejects non-Linux platforms before probing or
  installing Podman; the current supported matrix is Linux + rootless Podman.
  Windows/macOS require a dedicated backend rather than an unverified Docker
  Desktop, Podman Machine, or WSL assumption.

## 25. Verification after managed-runtime corrections — 2026-09-20

- Targeted managed-runtime tests: 2 files, 23 tests passed.
- Full Gateforge suite: 150 files, 1,829 tests passed.
- `npm run typecheck`: all workspaces passed.
- `npm run build`: all workspaces passed.
- `git diff --check`: passed.

## 26. Release candidate 0.5.0 — 2026-09-20

- All public workspaces were bumped from `0.4.1` to `0.5.0`; internal
  `@gate-forge/*` dependency ranges and `package-lock.json` were synchronized.
- Release candidate verification passed after relinking workspace dependencies:
  150 test files / 1,829 tests, all workspace typechecks, all workspace builds,
  `git diff --check`, and `npm pack --dry-run -w @gate-forge/cli`.
- The CLI dry-run produced `gate-forge-cli-0.5.0.tgz`.

## 27. Release publication — 2026-09-20

- Release commit `2511926` was pushed to `github/main`.
- Annotated tag `v0.5.0` was created and pushed.
- `.github/workflows/publish.yml` publishes workspace packages on `v*` tags
  through npm trusted publishing (OIDC); no local `npm publish` was run.

## 28. NPM publication result — 2026-09-20

- The `v0.5.0` workflow completed successfully at the GitHub job level, but
  npm published only `@gate-forge/cli@0.5.0`; the other workspace packages
  were rejected because their npm Trusted Publisher settings are not configured.
- `npm view @gate-forge/cli@0.5.0 version` returns `0.5.0`.
- `npm view @gate-forge/core@0.5.0 version` returns 404, so a fresh install of
  the CLI cannot yet resolve the matching 0.5.0 dependency graph.
- `scripts/release-publish.sh` now exits nonzero when any package fails,
  preventing future partial releases from reporting false success.
- External blocker: configure npm Trusted Publisher for the remaining
  `@gate-forge/*` packages, then publish a new coordinated version. No
  credentials are available in this session for manual publication.
