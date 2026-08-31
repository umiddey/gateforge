/**
 * Pack identity constants. The GPP/2 handshake pins these values: the
 * `.gateforge.yml` plugin entry MUST declare the same `id` and
 * `version` (see the pack README).
 *
 * Mirrors `packages/pack-sqlalchemy/src/version.ts`.
 */

/** Plugin id every background-task pack contribution is pinned to. */
export const PACK_PLUGIN_ID = 'gateforge.pack-task';

/** Detector/pack version. Bumped in lockstep with the protocol pin. */
export const PACK_VERSION = '0.1.0';