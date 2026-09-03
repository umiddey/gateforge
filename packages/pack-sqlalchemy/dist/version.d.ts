/**
 * Pack identity constants. The GPP/3 handshake pins these values: the
 * `.gateforge.yml` plugin entry MUST declare the same `id` and
 * `version` (see the pack README). The Python detector carries the same
 * constants in `python/gateforge_sqlalchemy_detector/__init__.py` — the
 * cross-language test asserts they agree.
 */
/** Plugin id every SQLAlchemy pack contribution is pinned to. */
export declare const PACK_PLUGIN_ID = "gateforge.pack-sqlalchemy";
/** Detector/pack version; must match `python/.../__init__.py::VERSION`. */
export declare const PACK_VERSION = "0.1.0";
//# sourceMappingURL=version.d.ts.map