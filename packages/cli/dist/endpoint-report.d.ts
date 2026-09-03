/**
 * Endpoint inventory reporting (plan phase 7): deterministic text
 * sections shared by the discover/check commands. Totals by method and
 * capability, frontend-consumption status, and — listed SEPARATELY, per
 * plan phase 7.3 — unmatched frontend calls, unconsumed backend routes,
 * and ambiguous endpoints. Nothing is hidden: these sections render even
 * when empty.
 */
import type { EndpointInventory } from './endpoint-compiler.js';
/** Renders the endpoint inventory text block (no trailing newline). */
export declare function renderEndpointInventory(inventory: EndpointInventory): string;
//# sourceMappingURL=endpoint-report.d.ts.map