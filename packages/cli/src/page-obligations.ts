import type { Obligation, ResourceGraph } from '@gate-forge/core';

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
