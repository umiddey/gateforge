/**
 * Optional plane attribution helpers for the SQLAlchemy detector.
 *
 * Core derives business meaning from normalized classification signals.
 */
/** The empty rule; core derives plane from normalized signals. */
export const NO_PLANE_MAPPING = () => null;
/** Rule that maps table names to planes; unmapped tables stay null. */
export function byTableName(mapping) {
    const table = new Map(Object.entries(mapping));
    return (context) => table.get(context.tableName) ?? null;
}
//# sourceMappingURL=planes.js.map