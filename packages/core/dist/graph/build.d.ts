import { type ResourceGraph, type ResourceGraphInput } from './schema.js';
/** Detector id stamped onto every graph-issued finding/entry. */
export declare const GRAPH_DETECTOR_ID = "gateforge.graph";
/**
 * Builds the resource graph. See the module doc for the normalization
 * rules; see `ResourceGraphSchema` for the output shape.
 *
 * Args:
 *   input: detector contributions, classifications document, and the
 *     claim/adapter/waiver populations to watch for staleness.
 *
 * Returns:
 *   ResourceGraph: normalized, sorted, byte-for-byte deterministic.
 * @throws z.ZodError when the classifications document is invalid —
 *   classification config fails closed (ADR 0001 D5.1).
 */
export declare function buildResourceGraph(input: ResourceGraphInput): ResourceGraph;
//# sourceMappingURL=build.d.ts.map