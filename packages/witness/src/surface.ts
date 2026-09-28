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
 * The current surface-descriptor version. Version 3 adds constrained
 * locator-based list fields; earlier cell-index descriptors stay valid.
 */
export const SURFACE_DESCRIPTOR_VERSION = 3;

/** Legacy surface-descriptor version (single-form create only). */
export const SURFACE_DESCRIPTOR_VERSION_1 = 1;
/** Surface-descriptor version with optional wizard create steps. */
export const SURFACE_DESCRIPTOR_VERSION_2 = 2;

/** Shared list-page and row selectors. */
interface SurfaceListBase {
  /** List page path relative to the app base (e.g. `/`). */
  path: string;
  /** Selector proving the list page rendered (e.g. the page heading). */
  readySelector: string;
  /** Selector matching one entity row inside the list. */
  rowSelector: string;
}

/** How v1/v2 list rows expose ids and fields in table cells. */
export interface SurfaceListCells extends SurfaceListBase {
  /** Index of the row cell carrying the entity id (0-based). */
  idCellIndex: number;
  /** Field name → 0-based row-cell index, for reading rendered fields. */
  fieldCellIndexes: Record<string, number>;
  idLocator?: never;
  fieldLocators?: never;
}

/** How a v3 list row exposes ids and fields through relative locators. */
export interface SurfaceListLocators extends SurfaceListBase {
  /** Locator evaluated inside one matched row to read its entity id. */
  idLocator: string;
  /** Field name → locator evaluated inside the matched row. */
  fieldLocators: Record<string, string>;
  idCellIndex?: never;
  fieldCellIndexes?: never;
}

/** List shape selected by the surface descriptor version. */
export type SurfaceList = SurfaceListCells | SurfaceListLocators;

/** How the CREATE form is driven (legacy single form, v1 + v2). */
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
 * One engine-driven wizard step (surface v2, Phase 3): the closed
 * operation set the engine can perform while walking a multi-screen
 * create flow (draft orb → type picker → radios → searchable lists →
 * submit). Steps are LOCATORS plus field references — never proof: a
 * lying step fails closed (elements never match) exactly like a lying
 * legacy selector. Custom searchable dropdowns, drag-and-drop, file
 * pickers, and hover menus are NOT expressible — those flows stay on
 * the Observe channel (documented limitation, never silently widened).
 */
export type SurfaceStep =
  /** Navigate to an app-relative path. */
  | { goto: string }
  /** Click a selector. */
  | { click: string }
  /**
   * Fill an input: `field` references a test-input field name (the
   * engine types the journey's value for it); `value` is a literal the
   * map declares. Exactly one of the two.
   */
  | { fill: { selector: string; field?: string; value?: string } }
  /** Check a radio/checkbox. */
  | { check: string }
  /** Press a dismiss/confirm key (dialogs that close on Escape/Enter). */
  | { press: 'Escape' | 'Enter' }
  /** Wait for a selector (async panels, search results). */
  | { waitFor: string };

/**
 * Wizard-driven CREATE (surface v2): `steps` replace the legacy
 * single-form trio (`formPath`/`formReadySelector`/`submitSelector`
 * must be ABSENT — a mixed descriptor is refused fail-closed, never
 * driven half-legacy). `fields` stays REQUIRED: it declares the input
 * vocabulary the test provides and the echo grades.
 */
export interface SurfaceCreateSteps {
  /** Declared input vocabulary (echo source; selectors live in steps). */
  fields: Record<string, string>;
  /** The wizard walk, in order. Non-empty. */
  steps: SurfaceStep[];
}

/** How CREATE is driven: one legacy form (v1 + v2) or a wizard walk (v2 only). */
export type SurfaceCreateFlow = SurfaceCreate | SurfaceCreateSteps;

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
  /** Version 3 adds relative list locators; cell indexes remain compatible. */
  schemaVersion: number;
  list: SurfaceList;
  create: SurfaceCreateFlow;
  edit: SurfaceEdit;
  archive: SurfaceArchive;
  status: SurfaceStatus;
  /**
   * Where the browser lands after a successful mutation (the rendered
   * result page); `path` is the expected `location.pathname`.
   */
  afterAction: { path: string };
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
export function renderSurfaceTemplate(template: string, entityId: string): string {
  if (/['"\r\n\\]/.test(entityId)) {
    throw new Error(
      `surface template '${template}' cannot be rendered for entity id ${JSON.stringify(entityId)}: ` +
        'ids carrying quotes or control characters are rejected fail-closed',
    );
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
export function validateSurface(surface: SurfaceDescriptor): SurfaceDescriptor {
  if (typeof surface !== 'object' || surface === null || Array.isArray(surface)) {
    throw new Error('surface must be a SurfaceDescriptor object declared by the consumer');
  }
  if (
    surface.schemaVersion !== SURFACE_DESCRIPTOR_VERSION_1 &&
    surface.schemaVersion !== SURFACE_DESCRIPTOR_VERSION_2 &&
    surface.schemaVersion !== SURFACE_DESCRIPTOR_VERSION
  ) {
    throw new Error(
      `surface.schemaVersion ${String(surface.schemaVersion)} is not supported: this pack speaks ` +
        `surface-descriptor versions ${String(SURFACE_DESCRIPTOR_VERSION_1)} (legacy single-form ` +
        `create), ${String(SURFACE_DESCRIPTOR_VERSION_2)} (wizard steps), and ` +
        `${String(SURFACE_DESCRIPTOR_VERSION)} (relative list locators) — redeclare ` +
        'the surface against a current version',
    );
  }
  for (const section of ['list', 'create', 'edit', 'archive', 'status', 'afterAction'] as const) {
    if (typeof surface[section] !== 'object' || surface[section] === null) {
      throw new Error(`surface.${section} is required by the surface descriptor`);
    }
  }
  for (const key of ['path', 'readySelector', 'rowSelector'] as const) {
    if (typeof surface.list[key] !== 'string' || surface.list[key].length === 0) {
      throw new Error(`surface.list.${key} must be a non-empty string`);
    }
  }
  if (surface.schemaVersion === SURFACE_DESCRIPTOR_VERSION) {
    const hasRelativeLocators = 'idLocator' in surface.list || 'fieldLocators' in surface.list;
    if (hasRelativeLocators) {
      const locatorList = surface.list as SurfaceListLocators;
      if (typeof locatorList.idLocator !== 'string' || locatorList.idLocator.length === 0) {
        throw new Error('surface.list.idLocator must be a non-empty locator relative to the row');
      }
      requireSelectorMap('list.fieldLocators', locatorList.fieldLocators);
      if ('idCellIndex' in surface.list || 'fieldCellIndexes' in surface.list) {
        throw new Error('surface v3 list must not mix relative locators and cell indexes');
      }
    } else {
      // A v3 descriptor may keep an existing table-index map unchanged.
      const cellList = surface.list as SurfaceListCells;
      if (!Number.isInteger(cellList.idCellIndex) || (cellList.idCellIndex as number) < 0) {
        throw new Error('surface.list.idLocator or a non-negative idCellIndex is required');
      }
      requireIndexMap('list.fieldCellIndexes', cellList.fieldCellIndexes);
    }
  } else {
    const cellList = surface.list as SurfaceListCells;
    if (!Number.isInteger(cellList.idCellIndex) || (cellList.idCellIndex as number) < 0) {
      throw new Error('surface.list.idCellIndex must be a non-negative integer');
    }
    requireIndexMap('list.fieldCellIndexes', cellList.fieldCellIndexes);
    if ('idLocator' in surface.list || 'fieldLocators' in surface.list) {
      throw new Error('surface v1/v2 list must use cell indexes, not v3 relative locators');
    }
  }
  validateCreateFlow(surface.schemaVersion, surface.create);
  for (const key of ['linkSelector', 'formReadySelectorTemplate', 'saveSelectorTemplate'] as const) {
    if (typeof surface.edit[key] !== 'string' || surface.edit[key].length === 0) {
      throw new Error(`surface.edit.${key} must be a non-empty string`);
    }
  }
  requireSelectorMap('edit.fields', surface.edit.fields);
  if (
    typeof surface.archive.controlSelectorTemplate !== 'string' ||
    surface.archive.controlSelectorTemplate.length === 0
  ) {
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
 * Requires a field name → selector record (module-level: shared by the
 * descriptor validator and the create-flow validator).
 */
function requireSelectorMap(where: string, map: Record<string, string>): void {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    throw new Error(`surface.${where} must be a record of field name → selector`);
  }
  for (const [field, selector] of Object.entries(map)) {
    if (typeof selector !== 'string' || selector.length === 0) {
      throw new Error(`surface.${where}.${field} must be a non-empty selector string`);
    }
  }
}

/**
 * Requires a field name → cell index record (module-level: shared by
 * the descriptor validator and the create-flow validator).
 */
function requireIndexMap(where: string, map: Record<string, number>): void {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    throw new Error(`surface.${where} must be a record of field name → cell index`);
  }
  for (const [field, index] of Object.entries(map)) {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`surface.${where}.${field} must be a non-negative integer cell index`);
    }
  }
}

/**
 * Validates the create flow: legacy single-form trio, or a wizard step
 * walk in versions 2 and 3. Mixed shapes fail closed.
 */
function validateCreateFlow(schemaVersion: number, create: SurfaceCreateFlow): void {
  if (typeof create !== 'object' || create === null || Array.isArray(create)) {
    throw new Error('surface.create must be an object (legacy form or v2 steps)');
  }
  const record = create as unknown as Record<string, unknown>;
  if ('steps' in record) {
    if (schemaVersion !== SURFACE_DESCRIPTOR_VERSION_2 && schemaVersion !== SURFACE_DESCRIPTOR_VERSION) {
      throw new Error(
        'surface.create.steps requires surface-descriptor version ' +
          `${String(SURFACE_DESCRIPTOR_VERSION_2)} or ${String(SURFACE_DESCRIPTOR_VERSION)} ` +
          `(declared ${String(schemaVersion)})`,
      );
    }
    for (const legacy of ['formPath', 'formReadySelector', 'submitSelector'] as const) {
      if (record[legacy] !== undefined) {
        throw new Error(
          `surface.create mixes wizard steps with legacy '${legacy}' — declare steps or the ` +
            'single form, never both',
        );
      }
    }
    requireSelectorMap('create.fields', (create as SurfaceCreateSteps).fields);
    validateSteps((create as SurfaceCreateSteps).steps, (create as SurfaceCreateSteps).fields);
    return;
  }
  for (const key of ['formPath', 'formReadySelector', 'submitSelector'] as const) {
    if (typeof (create as SurfaceCreate)[key] !== 'string' || (create as SurfaceCreate)[key].length === 0) {
      throw new Error(`surface.create.${key} must be a non-empty string`);
    }
  }
  requireSelectorMap('create.fields', (create as SurfaceCreate).fields);
}

/**
 * Validates one wizard step walk: non-empty, closed operation set,
 * non-empty selectors/paths, fills carrying exactly one of
 * field/value with the field in the declared vocabulary.
 */
function validateSteps(steps: SurfaceStep[], fields: Record<string, string>): void {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('surface.create.steps must be a non-empty array of wizard steps');
  }
  steps.forEach((step, index) => {
    const where = `surface.create.steps[${String(index)}]`;
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      throw new Error(`${where} must be a single-operation step object`);
    }
    const keys = Object.keys(step);
    if (keys.length !== 1) {
      throw new Error(`${where} must carry exactly one operation (goto/click/fill/check/press/waitFor)`);
    }
    const operation = keys[0] as 'goto' | 'click' | 'fill' | 'check' | 'press' | 'waitFor';
    const value = (step as Record<string, unknown>)[operation];
    switch (operation) {
      case 'goto':
      case 'click':
      case 'check':
      case 'waitFor':
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(`${where}.${operation} must be a non-empty string`);
        }
        if (operation === 'goto' && !value.startsWith('/')) {
          throw new Error(`${where}.goto must be an app-relative path starting with '/'`);
        }
        break;
      case 'press':
        if (value !== 'Escape' && value !== 'Enter') {
          throw new Error(`${where}.press must be 'Escape' or 'Enter'`);
        }
        break;
      case 'fill': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error(`${where}.fill must be {selector, field?/value?}`);
        }
        const fill = value as Record<string, unknown>;
        if (typeof fill['selector'] !== 'string' || (fill['selector'] as string).length === 0) {
          throw new Error(`${where}.fill.selector must be a non-empty string`);
        }
        const hasField = typeof fill['field'] === 'string' && (fill['field'] as string).length > 0;
        const hasValue = typeof fill['value'] === 'string';
        if (hasField === hasValue) {
          throw new Error(`${where}.fill needs exactly one of field/value (a test-input reference or a map literal)`);
        }
        if (hasField && !Object.prototype.hasOwnProperty.call(fields, fill['field'] as string)) {
          throw new Error(
            `${where}.fill.field '${fill['field'] as string}' is not in the declared create.fields ` +
              `vocabulary (${Object.keys(fields).sort().join(', ') || '<none>'})`,
          );
        }
        break;
      }
      default:
        throw new Error(
          `${where} carries unknown operation '${String(operation)}' (allowed: goto/click/fill/check/press/waitFor)`,
        );
    }
  });
}

/**
 * Fills descriptor input fields exactly: every declared key must be a
 * selector-known field with a string value (fail closed — the engine
 * never invents form fields the consumer did not declare).
 */
export function declaredSurfaceFields(
  where: string,
  input: Record<string, string>,
  known: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(input ?? {});
  if (entries.length === 0) {
    throw new Error(`${where} requires at least one input field the journey enters in the UI`);
  }
  const declared: Record<string, string> = {};
  for (const [field, value] of entries) {
    if (!(field in known)) {
      throw new Error(
        `${where} declares field '${field}' which the consumer's surface descriptor does not ` +
          `declare a selector for (declared fields: ${Object.keys(known).sort().join(', ')})`,
      );
    }
    if (typeof value !== 'string') {
      throw new Error(`${where}.${field} must be a string (form inputs are text)`);
    }
    declared[field] = value;
  }
  return declared;
}
