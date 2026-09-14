/**
 * The consumer-declared surface descriptor (plan Phase 1 item 7): the
 * APPLICATION-SPECIFIC half of evidence — how the rendered UI is
 * observed and driven (list page, rows and field cells, form templates,
 * archive control, status values). The pack ships selectors for NO
 * application; the consumer declares its own.
 *
 * OWNERSHIP: the descriptor's selectors are LOCATORS, never proof. The
 * engine-owned browser (witness `browser.ts`) drives the rendered app
 * with them and verifies navigation, the application request, the
 * visible outcome, and persistence itself — a lying descriptor fails
 * closed (elements never match) instead of manufacturing proof.
 */
/**
 * The surface-descriptor contract version this pack speaks. Consumers
 * must declare `schemaVersion: SURFACE_DESCRIPTOR_VERSION` in their
 * descriptor; a different version fails closed with a precise error
 * instead of silently misreading selectors.
 */
export declare const SURFACE_DESCRIPTOR_VERSION = 1;
/** How the rendered LIST page is observed (rows and their cells). */
export interface SurfaceList {
    /** List page path relative to the app base (e.g. `/`). */
    path: string;
    /** Selector proving the list page rendered (e.g. the page heading). */
    readySelector: string;
    /** Selector matching one entity row inside the list. */
    rowSelector: string;
    /** Index of the row cell carrying the entity id (0-based). */
    idCellIndex: number;
    /** Field name → 0-based row-cell index, for reading rendered fields. */
    fieldCellIndexes: Record<string, number>;
}
/** How the CREATE form is driven. */
export interface SurfaceCreate {
    /** Create-form page path relative to the app base. */
    formPath: string;
    /** Selector proving the create form rendered. */
    formReadySelector: string;
    /** Field name → input selector on the create form. */
    fields: Record<string, string>;
    /** Submit control selector on the create form. */
    submitSelector: string;
}
/**
 * How the EDIT form is reached and driven. `{id}` templates are
 * substituted with the entity id; the edit link is located INSIDE the
 * entity's row.
 */
export interface SurfaceEdit {
    /** Row-scoped selector of the control navigating to the edit form. */
    linkSelector: string;
    /** `{id}`-templated selector proving the edit form rendered. */
    formReadySelectorTemplate: string;
    /** Field name → input selector on the edit form. */
    fields: Record<string, string>;
    /** `{id}`-templated page-scoped selector of the edit SAVE control. */
    saveSelectorTemplate: string;
}
/** How the archive/delete control is located (row-scoped, `{id}`-templated). */
export interface SurfaceArchive {
    /** `{id}`-templated row-scoped selector of the archive/delete control. */
    controlSelectorTemplate: string;
}
/**
 * Rendered-status observations the primitives assert after create and
 * archive (fail-closed visible postconditions).
 */
export interface SurfaceStatus {
    /** Field name the status renders under (must be a row field). */
    field: string;
    /** Expected rendered value right after a create (e.g. `'active'`). */
    createdValue?: string;
    /** Expected rendered value after archive (e.g. `'archived'`). */
    archivedValue?: string;
}
/**
 * The declarative, consumer-owned description of the application
 * surface the evidence primitives observe (plan Phase 1 item 7): the
 * pack ships selectors for NO application — the consumer declares its
 * own. Selector/path strings containing `{id}` are substituted with the
 * entity id before use.
 */
export interface SurfaceDescriptor {
    /** Must equal {@link SURFACE_DESCRIPTOR_VERSION} (fail-closed otherwise). */
    schemaVersion: number;
    list: SurfaceList;
    create: SurfaceCreate;
    edit: SurfaceEdit;
    archive: SurfaceArchive;
    status: SurfaceStatus;
    /**
     * Where the browser lands after a successful mutation (the rendered
     * result page); `path` is the expected `location.pathname`.
     */
    afterAction: {
        path: string;
    };
    /**
     * Fields recorded on a delete/archive `ui.action` record (the
     * owner-declared archived state the journey drove, e.g.
     * `{status: 'archived'}`).
     */
    deleteFields: Record<string, string>;
}
/**
 * Substitutes `{id}` in a consumer-declared selector/path template with
 * the entity id. Fail closed on ids that could break selector context
 * (quotes/control characters) — a malformed id must error here, not
 * silently match a different element.
 */
export declare function renderSurfaceTemplate(template: string, entityId: string): string;
/**
 * Structural validation of the consumer-declared surface descriptor
 * (fail closed with the EXACT missing piece — a misdeclared surface must
 * never surface later as a confusing selector timeout).
 *
 * Args:
 *   surface: the candidate descriptor.
 *
 * Returns:
 *   SurfaceDescriptor: the same descriptor, validated.
 *
 * Throws:
 *   Error: naming the first structural problem found.
 */
export declare function validateSurface(surface: SurfaceDescriptor): SurfaceDescriptor;
/**
 * Fills descriptor input fields exactly: every declared key must be a
 * selector-known field with a string value (fail closed — the engine
 * never invents form fields the consumer did not declare).
 */
export declare function declaredSurfaceFields(where: string, input: Record<string, string>, known: Record<string, string>): Record<string, string>;
//# sourceMappingURL=surface.d.ts.map