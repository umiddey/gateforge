/**
 * Endpoint inventory reporting (plan phase 7): deterministic text
 * sections shared by the discover/check commands. Totals by method and
 * capability, frontend-consumption status, and — listed SEPARATELY, per
 * plan phase 7.3 — unmatched frontend calls, unconsumed backend routes,
 * and ambiguous endpoints. Nothing is hidden: these sections render even
 * when empty.
 */
import type { EndpointInventory } from './endpoint-compiler.js';

/** The per-method totals row. */
function methodTotals(inventory: EndpointInventory): string[] {
  const totals = new Map<string, number>();
  for (const endpoint of inventory.endpoints) {
    totals.set(endpoint.method, (totals.get(endpoint.method) ?? 0) + 1);
  }
  return [...totals.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([method, count]) => `${method}:${count}`);
}

/** Renders the endpoint inventory text block (no trailing newline). */
export function renderEndpointInventory(inventory: EndpointInventory): string {
  const lines: string[] = [];
  lines.push(`endpoint inventory (${inventory.endpoints.length}):`);
  lines.push(`  by method: ${methodTotals(inventory).join(' ') || '<none>'}`);
  const consumed = inventory.endpoints.filter((endpoint) => endpoint.frontendConsumed);
  lines.push(`  frontend-consumed: ${consumed.length} of ${inventory.endpoints.length}`);
  const capabilityTotals = new Map<string, number>();
  for (const endpoint of inventory.endpoints) {
    for (const capability of endpoint.capabilities) {
      capabilityTotals.set(capability, (capabilityTotals.get(capability) ?? 0) + 1);
    }
  }
  lines.push(
    `  capabilities: ${
      [...capabilityTotals.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([capability, count]) => `${capability}:${count}`)
        .join(' ') || '<none>'
    }`,
  );
  for (const endpoint of inventory.endpoints) {
    const calls = endpoint.calls.length;
    const route = endpoint.routes[0]?.source;
    const link = endpoint.linkedResourceName ?? '<unlinked>';
    lines.push(
      `  ${endpoint.identity}  capabilities=${endpoint.capabilities.join('+') || '<unresolved>'}  ` +
        `consumed=${calls > 0 ? 'yes' : 'no'}  link=${link}  route=${route?.file}:${route?.line}  callsites=${calls}`,
    );
  }

  const unwired = inventory.unwired;
  lines.push(`unmatched frontend calls (${unwired.length}):`);
  for (const block of unwired) {
    lines.push(`  [${block.code}] ${block.detail} — ${block.location.file}:${block.location.line}`);
  }

  const consumedIdentities = new Set(consumed.map((endpoint) => endpoint.identity));
  const unconsumed = inventory.endpoints.filter(
    (endpoint) => !consumedIdentities.has(endpoint.identity),
  );
  lines.push(`unconsumed backend routes (${unconsumed.length}):`);
  for (const endpoint of unconsumed) {
    const route = endpoint.routes[0]?.source;
    lines.push(`  ${endpoint.identity} — ${route?.file}:${route?.line}`);
  }

  const ambiguous = inventory.ambiguous;
  lines.push(`ambiguous joins (${ambiguous.length}):`);
  for (const block of ambiguous) {
    lines.push(`  [${block.code}] ${block.detail} — ${block.location.file}:${block.location.line}`);
  }
  return lines.join('\n');
}
