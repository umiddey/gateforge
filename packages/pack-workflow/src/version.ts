/**
 * Pack identity constants. The GPP/3 handshake pins these values: the
 * `.gateforge.yml` plugin entry MUST declare the same `id` and `version`
 * (see the pack README). `version` follows gateforge pack semantics
 * (mirror pack-sqlalchemy).
 */

/** Plugin id every workflow pack contribution is pinned to. */
export const PACK_PLUGIN_ID = 'gateforge.pack-workflow';

/** Detector/pack version. */
export const PACK_VERSION = '0.1.0';