/**
 * Consumer-owned surface descriptors for the behavior reference app
 * (plan 2026-09-19 Phase 6 item 5): profile and admin edit surfaces
 * over the shared accounts table, plus the import list surface. The
 * import mutation itself proves over engine-http (bulk JSON rows), so
 * the import descriptor only anchors list observation.
 *
 * Selectors match example/behavior/server.js markup. Validated
 * engine-side at drive time — worker approval never substitutes.
 */
export const profileSurface = Object.freeze({
  schemaVersion: 2,
  list: {
    path: '/profile/accounts',
    readySelector: 'h1:has-text("Profile accounts")',
    rowSelector: 'li',
    idCellIndex: 0,
    fieldCellIndexes: {},
  },
  create: {
    formPath: '/profile/accounts/new',
    formReadySelector: 'form',
    fields: {},
    submitSelector: 'button[type="submit"]',
  },
  edit: {
    linkSelector: 'a[href$="/edit"]',
    formReadySelectorTemplate: 'form[action="/profile/accounts/{id}"]',
    fields: {
      first_name: 'input[name="first_name"]',
      last_name: 'input[name="last_name"]',
    },
    saveSelectorTemplate: 'form[action="/profile/accounts/{id}"] button:not([formaction])',
  },
  archive: {
    controlSelectorTemplate: 'form[action="/profile/accounts/{id}/archive"] button',
  },
  status: {
    field: 'status',
    createdValue: 'active',
    archivedValue: 'archived',
  },
  afterAction: {
    path: '/profile/accounts',
  },
  deleteFields: { status: 'archived' },
});

export const adminSurface = Object.freeze({
  schemaVersion: 2,
  list: {
    path: '/admin/accounts',
    readySelector: 'h1:has-text("Admin accounts")',
    rowSelector: 'li',
    idCellIndex: 0,
    fieldCellIndexes: {},
  },
  create: {
    formPath: '/admin/accounts/new',
    formReadySelector: 'form',
    fields: {},
    submitSelector: 'button[type="submit"]',
  },
  edit: {
    linkSelector: 'a[href$="/edit"]',
    formReadySelectorTemplate: 'form[action="/admin/accounts/{id}"]',
    fields: {
      first_name: 'input[name="first_name"]',
      last_name: 'input[name="last_name"]',
    },
    saveSelectorTemplate: 'form[action="/admin/accounts/{id}"] button:not([formaction])',
  },
  archive: {
    controlSelectorTemplate: 'form[action="/admin/accounts/{id}/archive"] button',
  },
  status: {
    field: 'status',
    createdValue: 'active',
    archivedValue: 'archived',
  },
  afterAction: {
    path: '/admin/accounts',
  },
  deleteFields: { status: 'archived' },
});

export const importSurface = Object.freeze({
  schemaVersion: 2,
  list: {
    path: '/imports/accounts',
    readySelector: 'h1:has-text("Import accounts")',
    rowSelector: 'li',
    idCellIndex: 0,
    fieldCellIndexes: {},
  },
  create: {
    formPath: '/imports/accounts',
    formReadySelector: 'form[action="/imports/accounts"]',
    fields: {
      rows: 'textarea[name="rows"]',
    },
    submitSelector: 'button[type="submit"]',
  },
  edit: {
    linkSelector: 'a[href$="/edit"]',
    formReadySelectorTemplate: 'form[action="/imports/accounts/{id}"]',
    fields: {},
    saveSelectorTemplate: 'form[action="/imports/accounts/{id}"] button',
  },
  archive: {
    controlSelectorTemplate: 'form[action="/imports/accounts/{id}/archive"] button',
  },
  status: {
    field: 'status',
    createdValue: 'active',
    archivedValue: 'archived',
  },
  afterAction: {
    path: '/imports/accounts',
  },
  deleteFields: { status: 'archived' },
});
