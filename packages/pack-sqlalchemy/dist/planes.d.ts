/** The plane enum the graph accepts (`tenant | master | global`). */
export type SqlalchemyPlane = 'tenant' | 'master' | 'global';
/** Facts about one table resource a plane rule can key on. */
export interface PlaneContext {
    /** The table name (the graph identity attribute `resourceName`). */
    tableName: string;
    /** Dotted scope-qualified class name; `null` for `Table()` calls. */
    classQname: string | null;
    /** `literal` | `table-call-first-arg` (resolved names only). */
    provenance: string;
}
/**
 * A plane rule: returns the plane for a table, or `null` to leave the
 * plane to the graph's classification binding.
 */
export type PlaneRule = (context: PlaneContext) => SqlalchemyPlane | null;
/** The empty rule: no plane attribution; the graph classifies alone. */
export declare const NO_PLANE_MAPPING: PlaneRule;
/** Rule that maps table names to planes; unmapped tables stay null. */
export declare function byTableName(mapping: Record<string, SqlalchemyPlane>): PlaneRule;
/**
 * Builds a plane rule from a parsed classifications document, using the
 * graph's binding convention: a bare-name key wins; otherwise the unique
 * `<plane>.<name>` suffix key. A name classified on several planes
 * yields no plane here (the graph's `AMBIGUOUS_CLASSIFICATION_KEY`
 * finding stays authoritative).
 *
 * Args:
 *   document: The parsed classifications document (schema `1`).
 *
 * Returns:
 *   PlaneRule | null: A rule over the document's classifications, or
 *     `null` when the document is not a valid classifications file.
 */
export declare function fromClassificationsDocument(document: unknown): PlaneRule | null;
/**
 * Loads the plane rule configured by the project config in `cwd`.
 *
 * Best-effort by design: the CLASSIFIATIONS file is the authoritative
 * plane mapping; `attributes.plane` is a mirror/disambiguator, so any
 * config read problem (missing `.gateforge.yml`, unreadable or invalid
 * classifications document) degrades to {@link NO_PLANE_MAPPING} — the
 * downstream graph fails closed or classifies on its own either way.
 *
 * Args:
 *   cwd: Repo root (process working directory for a CLI run).
 *
 * Returns:
 *   PlaneRule: never throws.
 */
export declare function planeRuleFromProjectConfig(cwd: string): PlaneRule;
//# sourceMappingURL=planes.d.ts.map