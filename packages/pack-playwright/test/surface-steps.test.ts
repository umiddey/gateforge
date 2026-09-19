/**
 * Surface v2 wizard steps (Phase 3): descriptor validation (legacy v1
 * still accepted, mixed shapes refused, closed operation set, field
 * vocabulary enforced) and the engine step driver over a structural
 * stub page — no browser required. Proves call order, field
 * substitution, literal values, and fail-closed behavior on missing
 * input and unknown shapes.
 */
import { describe, expect, it } from 'vitest';
import {
  SURFACE_DESCRIPTOR_VERSION,
  validateSurface,
  type SurfaceDescriptor,
  type SurfaceStep,
} from '../src/surface.js';
import { driveCreateSteps, EngineBrowserError, type StepPage } from '../src/witness/browser.js';

/** The legacy accounts surface shape (single-form create). */
function legacySurface(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    list: { path: '/', readySelector: 'h1', rowSelector: 'tbody tr', idCellIndex: 0, fieldCellIndexes: { first_name: 1 } },
    create: {
      formPath: '/accounts/new',
      formReadySelector: 'form',
      fields: { first_name: 'input[name="first_name"]' },
      submitSelector: 'button[type="submit"]',
    },
    edit: {
      linkSelector: 'a[href$="/edit"]',
      formReadySelectorTemplate: 'form[action="/accounts/{id}"]',
      fields: { first_name: 'input[name="first_name"]' },
      saveSelectorTemplate: 'form[action="/accounts/{id}"] button:not([formaction])',
    },
    archive: { controlSelectorTemplate: 'form[action="/accounts/{id}/archive"] button' },
    status: { field: 'status', createdValue: 'active', archivedValue: 'archived' },
    afterAction: { path: '/' },
    deleteFields: { status: 'archived' },
    ...overrides,
  };
}

/** A wizard create block in the vendor-contract shape. */
function wizardCreate(): Record<string, unknown> {
  return {
    fields: { supplier_name: 'text', delivery_terms: 'text' },
    steps: [
      { goto: '/contracts' },
      { click: '[data-testid="draft-orb"]' },
      { click: '[data-testid="draft-orb-create-rental_contract"]' },
      { click: 'text=Vendor' },
      { check: 'input[name="scopeType"][value="building"]' },
      { fill: { selector: 'input[placeholder*="Supplier"]', field: 'supplier_name' } },
      { fill: { selector: 'input[placeholder*="delivery"]', value: 'FOB Berlin' } },
      { waitFor: '[data-testid="record-sheet-primary"]' },
      { click: '[data-testid="record-sheet-primary"]' },
    ],
  };
}

/** A structural stub page recording every interaction, in order. */
function stubPage(): { page: StepPage; calls: string[] } {
  const calls: string[] = [];
  const page: StepPage = {
    goto: async (url: string) => {
      calls.push(`goto ${url}`);
    },
    waitForSelector: async (selector: string) => {
      calls.push(`waitFor ${selector}`);
    },
    locator: (selector: string) => ({
      click: async () => {
        calls.push(`click ${selector}`);
      },
      fill: async (value: string) => {
        calls.push(`fill ${selector}=${value}`);
      },
      check: async () => {
        calls.push(`check ${selector}`);
      },
    }),
    keyboard: {
      press: async (key: string) => {
        calls.push(`press ${key}`);
      },
    },
  };
  return { page, calls };
}

describe('validateSurface versions', () => {
  it('accepts the legacy v1 single-form descriptor unchanged', () => {
    expect(() => validateSurface(legacySurface() as unknown as SurfaceDescriptor)).not.toThrow();
  });

  it('accepts a v2 wizard descriptor', () => {
    const surface = legacySurface({ schemaVersion: 2, create: wizardCreate() });
    expect(() => validateSurface(surface as unknown as SurfaceDescriptor)).not.toThrow();
  });

  it('accepts v2 with a legacy create trio (steps are opt-in)', () => {
    const legacy = legacySurface({ schemaVersion: 2 });
    expect(() => validateSurface(legacy as unknown as SurfaceDescriptor)).not.toThrow();
  });

  it('rejects unknown versions with both supported versions named', () => {
    expect(() => validateSurface(legacySurface({ schemaVersion: 9 }) as unknown as SurfaceDescriptor)).toThrow(
      /versions 1.* and 2|1.*2/,
    );
  });

  it('refuses steps under v1', () => {
    const mixed = legacySurface({ create: wizardCreate() });
    expect(() => validateSurface(mixed as unknown as SurfaceDescriptor)).toThrow(/version 2/);
  });

  it('refuses mixed steps + legacy trio', () => {
    const create = { ...(wizardCreate() as Record<string, unknown>), formPath: '/x', formReadySelector: 'form', submitSelector: 'button' };
    expect(() => validateSurface(legacySurface({ schemaVersion: 2, create }) as unknown as SurfaceDescriptor)).toThrow(
      /never both|declare steps or the single form/,
    );
  });

  it('refuses empty steps, multi-operation steps, and unknown operations', () => {
    const empty = { fields: { a: 'text' }, steps: [] };
    expect(() => validateSurface(legacySurface({ schemaVersion: 2, create: empty }) as unknown as SurfaceDescriptor)).toThrow(/non-empty array/);
    const multi = { fields: { a: 'text' }, steps: [{ click: 'a', goto: '/b' }] };
    expect(() => validateSurface(legacySurface({ schemaVersion: 2, create: multi }) as unknown as SurfaceDescriptor)).toThrow(/exactly one operation/);
    const unknown = { fields: { a: 'text' }, steps: [{ drag: 'a' }] };
    expect(() => validateSurface(legacySurface({ schemaVersion: 2, create: unknown }) as unknown as SurfaceDescriptor)).toThrow(/unknown operation/);
  });

  it('refuses bad selectors, bad goto targets, and bad press keys', () => {
    const blank = { fields: { a: 'text' }, steps: [{ click: '' }] };
    expect(() => validateSurface(legacySurface({ schemaVersion: 2, create: blank }) as unknown as SurfaceDescriptor)).toThrow(/non-empty string/);
    const relative = { fields: { a: 'text' }, steps: [{ goto: 'contracts' }] };
    expect(() => validateSurface(legacySurface({ schemaVersion: 2, create: relative }) as unknown as SurfaceDescriptor)).toThrow(/starting with '\/'/);
    const key = { fields: { a: 'text' }, steps: [{ press: 'Tab' }] };
    expect(() => validateSurface(legacySurface({ schemaVersion: 2, create: key }) as unknown as SurfaceDescriptor)).toThrow(/'Escape' or 'Enter'/);
  });

  it('refuses fills without exactly one of field/value and unknown field refs', () => {
    const neither = { fields: { a: 'text' }, steps: [{ fill: { selector: 'input' } }] };
    expect(() => validateSurface(legacySurface({ schemaVersion: 2, create: neither }) as unknown as SurfaceDescriptor)).toThrow(/exactly one of field\/value/);
    const both = { fields: { a: 'text' }, steps: [{ fill: { selector: 'input', field: 'a', value: 'x' } }] };
    expect(() => validateSurface(legacySurface({ schemaVersion: 2, create: both }) as unknown as SurfaceDescriptor)).toThrow(/exactly one of field\/value/);
    const unknownField = { fields: { a: 'text' }, steps: [{ fill: { selector: 'input', field: 'b' } }] };
    expect(() => validateSurface(legacySurface({ schemaVersion: 2, create: unknownField }) as unknown as SurfaceDescriptor)).toThrow(/not in the declared create\.fields vocabulary/);
  });
});

describe('driveCreateSteps (stub page, no browser)', () => {
  it('walks the wizard in order with field substitution and literals', async () => {
    const { page, calls } = stubPage();
    const create = wizardCreate();
    await driveCreateSteps(page, 'http://127.0.0.1:9', create['steps'] as SurfaceStep[], {
      supplier_name: 'Acme',
      delivery_terms: 'FOB',
    });
    expect(calls).toEqual([
      'goto http://127.0.0.1:9/contracts',
      'click [data-testid="draft-orb"]',
      'click [data-testid="draft-orb-create-rental_contract"]',
      'click text=Vendor',
      'check input[name="scopeType"][value="building"]',
      'fill input[placeholder*="Supplier"]=Acme',
      'fill input[placeholder*="delivery"]=FOB Berlin',
      'waitFor [data-testid="record-sheet-primary"]',
      'click [data-testid="record-sheet-primary"]',
    ]);
  });

  it('drives press steps through the keyboard', async () => {
    const { page, calls } = stubPage();
    await driveCreateSteps(page, 'http://127.0.0.1:9', [{ press: 'Escape' }], {});
    expect(calls).toEqual(['press Escape']);
  });

  it('fails closed when a referenced field has no journey value', async () => {
    const { page } = stubPage();
    await expect(
      driveCreateSteps(page, 'http://127.0.0.1:9', [{ fill: { selector: 'input', field: 'missing' } }], {}),
    ).rejects.toBeInstanceOf(EngineBrowserError);
  });

  it('refuses unknown shapes defensively (unreachable post-validation)', async () => {
    const { page } = stubPage();
    await expect(
      driveCreateSteps(page, 'http://127.0.0.1:9', [{ drag: 'x' } as unknown as SurfaceStep], {}),
    ).rejects.toBeInstanceOf(EngineBrowserError);
  });

  it('exposes the current descriptor version as 2', () => {
    expect(SURFACE_DESCRIPTOR_VERSION).toBe(2);
  });
});
