import { EvidenceRecordSchema, type EvidenceRecord, type Obligation, type ObligationVerdict, type ResourceGraph } from '@gate-forge/core';

/** Compile the two page promises for each plane-resolved page resource. */
export function pageObligationsFromGraph(graph: ResourceGraph): Obligation[] {
  const obligations: Obligation[] = [];
  for (const resource of graph.resources) {
    if (resource.kind !== 'ui.page' || resource.id === null) continue;
    const lifecycle = resource.classification?.lifecycle ?? { create: false, read: false, update: false, delete: false };
    obligations.push({ schemaVersion: 1, id: `${resource.id}:page:loads`, resourceId: resource.id, contract: 'page:loads', policyId: 'page-policy', lifecycle });
    obligations.push({ schemaVersion: 1, id: `${resource.id}:page:data-ok`, resourceId: resource.id, contract: 'page:data-ok', policyId: 'page-policy', lifecycle });
  }
  return obligations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Engine-observed entity IDs grouped by the resource whose create claim produced them. */
export function createdEntityIdsFromRecords(records: readonly unknown[]): Map<string, Set<string>> {
  const idsByResource = new Map<string, Set<string>>();
  for (const raw of records) {
    const parsed = EvidenceRecordSchema.safeParse(raw);
    if (!parsed.success) continue;
    const record = parsed.data;
    if (record.kind !== 'ui.action' || record.origin !== 'engine-observed' || record.trust !== 'witnessed') continue;
    const payload = record.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const action = payload as Record<string, unknown>;
    if (
      action['operation'] !== 'create' ||
      typeof action['entityId'] !== 'string' ||
      action['entityId'].length === 0
    ) {
      continue;
    }
    const resourceId = record.obligationId.split(':')[0];
    if (resourceId === undefined || resourceId.length === 0) continue;
    const ids = idsByResource.get(resourceId) ?? new Set<string>();
    ids.add(action['entityId']);
    idsByResource.set(resourceId, ids);
  }
  return idsByResource;
}

/** Resolves configured or uniquely observed IDs into one referee route; ambiguous values remain unbound. */
export function bindPageRouteParams(
  path: string,
  audience: string,
  configured: Readonly<Record<string, string>> | undefined,
  createdIds: ReadonlyMap<string, ReadonlySet<string>>,
): { path: string | null; unbound: string[] } {
  const names = [...path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)];
  let resolvedPath = path;
  const unbound: string[] = [];
  for (const match of names) {
    const name = match[1] as string;
    let id = configured?.[name];
    if (id === undefined && names.length === 1) {
      const resourceName = path.slice(0, match.index).split('/').filter(Boolean).at(-1);
      const ids = resourceName === undefined ? [] : [...(createdIds.get(`${audience}.${resourceName}`) ?? [])];
      if (ids.length === 1) id = ids[0];
    }
    if (id === undefined) {
      unbound.push(name);
      continue;
    }
    resolvedPath = resolvedPath.replace(`:${name}`, encodeURIComponent(id));
  }
  return unbound.length === 0 ? { path: resolvedPath, unbound } : { path: null, unbound };
}

export interface PageReportEntry {
  pageId: string;
  path: string;
  channel: 'observed' | 'swept' | null;
  test: string | null;
  status: string;
  reason: string | null;
}

/** Build the additive per-page summary from graded verdicts and validated witness records. */
export function pageReportEntries(
  graph: ResourceGraph,
  verdicts: readonly ObligationVerdict[],
  rawRecords: readonly unknown[],
): PageReportEntry[] {
  const records = new Map<string, EvidenceRecord>();
  for (const raw of rawRecords) {
    const parsed = EvidenceRecordSchema.safeParse(raw);
    if (parsed.success && parsed.data.recordId !== undefined) records.set(parsed.data.recordId, parsed.data);
  }
  const entries: PageReportEntry[] = [];
  for (const resource of graph.resources) {
    if (resource.kind !== 'ui.page' || resource.id === null) continue;
    const pageVerdicts = verdicts.filter(
      (verdict) =>
        verdict.obligation.id === `${resource.id}:page:loads` ||
        verdict.obligation.id === `${resource.id}:page:data-ok`,
    );
    const evidence = pageVerdicts
      .flatMap((verdict) => verdict.recordIds.map((recordId) => records.get(recordId)))
      .find((record) => {
        if (
          record === undefined ||
          record.kind !== 'page.observed' ||
          record.origin !== 'engine-observed' ||
          record.trust !== 'witnessed' ||
          record.payload === null ||
          typeof record.payload !== 'object' ||
          Array.isArray(record.payload)
        ) {
          return false;
        }
        const payload = record.payload as Record<string, unknown>;
        return payload['channel'] === 'observed' || payload['channel'] === 'swept';
      });
    const evidencePayload =
      evidence !== undefined &&
      evidence.payload !== null &&
      typeof evidence.payload === 'object' &&
      !Array.isArray(evidence.payload)
        ? (evidence.payload as Record<string, unknown>)
        : null;
    const channel = evidencePayload?.['channel'];
    const statuses = pageVerdicts.map((verdict) => verdict.verdict);
    const status =
      statuses.length === 0
        ? 'not-graded'
        : statuses.length === 2 && statuses.every((verdict) => verdict === 'satisfied')
          ? 'satisfied'
          : statuses.includes('invalid')
            ? 'invalid'
            : statuses.includes('waived')
              ? 'waived'
              : 'missing';
    const reasons = [...new Set(pageVerdicts.flatMap((verdict) => (verdict.reason === null ? [] : [verdict.reason])))];
    const attributes = resource.attributes as Record<string, unknown>;
    entries.push({
      pageId: resource.id,
      path: typeof attributes['path'] === 'string' ? attributes['path'] : resource.id,
      channel: channel === 'observed' || channel === 'swept' ? channel : null,
      test: evidence === undefined ? null : evidence.testId === 'page-sweep' ? 'referee' : (evidence.testId ?? null),
      status,
      reason: reasons.length === 0 ? null : reasons.join('; '),
    });
  }
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : left.pageId < right.pageId ? -1 : left.pageId > right.pageId ? 1 : 0,
  );
}
