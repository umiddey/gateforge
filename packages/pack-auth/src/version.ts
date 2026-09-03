/**
 * Pack identity constants. The GPP/3 handshake pins these values: the
 * `.gateforge.yml` plugin entry MUST declare the same `id` and `version`.
 */

/** Plugin id every auth pack contribution is pinned to. */
export const PACK_PLUGIN_ID = 'gateforge.pack-auth';

/** Detector/pack version; bumped on schema-changing changes. */
export const PACK_VERSION = '0.1.0';