/**
 * Optional plane attribution helpers for the SQLAlchemy detector.
 *
 * Core derives business meaning from normalized classification signals.
 */
/** The plane enum the graph accepts. */
export type SqlalchemyPlane = 'tenant' | 'master' | 'global';
/** Facts about one table resource a plane rule can key on. */
export interface PlaneContext {
    tableName: string;
    classQname: string | null;
    provenance: string;
}
/** A plane rule returns a plane, or null to leave binding to core. */
export type PlaneRule = (context: PlaneContext) => SqlalchemyPlane | null;
/** The empty rule; core derives plane from normalized signals. */
export declare const NO_PLANE_MAPPING: PlaneRule;
/** Rule that maps table names to planes; unmapped tables stay null. */
export declare function byTableName(mapping: Record<string, SqlalchemyPlane>): PlaneRule;
//# sourceMappingURL=planes.d.ts.map