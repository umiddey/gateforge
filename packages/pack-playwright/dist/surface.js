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
export const SURFACE_DESCRIPTOR_VERSION = 1;
/**
 * Substitutes `{id}` in a consumer-declared selector/path template with
 * the entity id. Fail closed on ids that could break selector context
 * (quotes/control characters) — a malformed id must error here, not
 * silently match a different element.
 */
export function renderSurfaceTemplate(template, entityId) {
    if (/['"\r\n\\]/.test(entityId)) {
        throw new Error(`surface template '${template}' cannot be rendered for entity id ${JSON.stringify(entityId)}: ` +
            'ids carrying quotes or control characters are rejected fail-closed');
    }
    return template.replaceAll('{id}', entityId);
}
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
export function validateSurface(surface) {
    const requireSelectorMap = (where, map) => {
        if (typeof map !== 'object' || map === null || Array.isArray(map)) {
            throw new Error(`surface.${where} must be a record of field name → selector`);
        }
        for (const [field, selector] of Object.entries(map)) {
            if (typeof selector !== 'string' || selector.length === 0) {
                throw new Error(`surface.${where}.${field} must be a non-empty selector string`);
            }
        }
    };
    const requireIndexMap = (where, map) => {
        if (typeof map !== 'object' || map === null || Array.isArray(map)) {
            throw new Error(`surface.${where} must be a record of field name → cell index`);
        }
        for (const [field, index] of Object.entries(map)) {
            if (!Number.isInteger(index) || index < 0) {
                throw new Error(`surface.${where}.${field} must be a non-negative integer cell index`);
            }
        }
    };
    if (typeof surface !== 'object' || surface === null || Array.isArray(surface)) {
        throw new Error('surface must be a SurfaceDescriptor object declared by the consumer');
    }
    if (surface.schemaVersion !== SURFACE_DESCRIPTOR_VERSION) {
        throw new Error(`surface.schemaVersion ${String(surface.schemaVersion)} is not supported: this pack speaks ` +
            `surface-descriptor version ${String(SURFACE_DESCRIPTOR_VERSION)} — redeclare the surface ` +
            'against the current version');
    }
    for (const section of ['list', 'create', 'edit', 'archive', 'status', 'afterAction']) {
        if (typeof surface[section] !== 'object' || surface[section] === null) {
            throw new Error(`surface.${section} is required by the surface descriptor`);
        }
    }
    for (const key of ['path', 'readySelector', 'rowSelector']) {
        if (typeof surface.list[key] !== 'string' || surface.list[key].length === 0) {
            throw new Error(`surface.list.${key} must be a non-empty string`);
        }
    }
    if (!Number.isInteger(surface.list.idCellIndex) || surface.list.idCellIndex < 0) {
        throw new Error('surface.list.idCellIndex must be a non-negative integer');
    }
    requireIndexMap('list.fieldCellIndexes', surface.list.fieldCellIndexes);
    for (const key of ['formPath', 'formReadySelector', 'submitSelector']) {
        if (typeof surface.create[key] !== 'string' || surface.create[key].length === 0) {
            throw new Error(`surface.create.${key} must be a non-empty string`);
        }
    }
    requireSelectorMap('create.fields', surface.create.fields);
    for (const key of ['linkSelector', 'formReadySelectorTemplate', 'saveSelectorTemplate']) {
        if (typeof surface.edit[key] !== 'string' || surface.edit[key].length === 0) {
            throw new Error(`surface.edit.${key} must be a non-empty string`);
        }
    }
    requireSelectorMap('edit.fields', surface.edit.fields);
    if (typeof surface.archive.controlSelectorTemplate !== 'string' ||
        surface.archive.controlSelectorTemplate.length === 0) {
        throw new Error('surface.archive.controlSelectorTemplate must be a non-empty string');
    }
    if (typeof surface.status.field !== 'string' || surface.status.field.length === 0) {
        throw new Error('surface.status.field must be a non-empty field name');
    }
    if (typeof surface.afterAction.path !== 'string' || surface.afterAction.path.length === 0) {
        throw new Error('surface.afterAction.path must be a non-empty path string');
    }
    requireSelectorMap('deleteFields', surface.deleteFields);
    return surface;
}
/**
 * Fills descriptor input fields exactly: every declared key must be a
 * selector-known field with a string value (fail closed — the engine
 * never invents form fields the consumer did not declare).
 */
export function declaredSurfaceFields(where, input, known) {
    const entries = Object.entries(input ?? {});
    if (entries.length === 0) {
        throw new Error(`${where} requires at least one input field the journey enters in the UI`);
    }
    const declared = {};
    for (const [field, value] of entries) {
        if (!(field in known)) {
            throw new Error(`${where} declares field '${field}' which the consumer's surface descriptor does not ` +
                `declare a selector for (declared fields: ${Object.keys(known).sort().join(', ')})`);
        }
        if (typeof value !== 'string') {
            throw new Error(`${where}.${field} must be a string (form inputs are text)`);
        }
        declared[field] = value;
    }
    return declared;
}
//# sourceMappingURL=surface.js.map