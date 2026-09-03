/**
 * Pack identity constants. The GPP/3 handshake pins these values: the
 * `.gateforge.yml` plugin entry MUST declare the same `id` and `version`
 * (see the pack README).
 */

/** Plugin id every FastAPI pack contribution is pinned to. */
export const PACK_PLUGIN_ID = 'gateforge.pack-fastapi';

/** Detector/pack version. Must match `python/gateforge_fastapi_detector/__init__.py`. */
export const PACK_VERSION = '0.1.0';
