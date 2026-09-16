/**
 * The engine-owned browser (plan Phase 1 item 4): Chromium contexts the
 * WITNESS process creates and drives itself — one isolated context per
 * supervisor-opened test session, closed when the session seals.
 *
 * Test code NEVER touches these pages: the worker holds no handle, no
 * URL, and no capability over them. The engine executes the constrained
 * surface operations (create/read/update/archive) with the
 * consumer-declared locators, and observes each step itself:
 * - the rendered control it clicked and the values it typed;
 * - the actual application request the action caused (captured from the
 *   engine page's own network, app-origin only);
 * - the resulting navigation and the rendered row/form it read back.
 *
 * Forgery resistance (why this channel is proof):
 * - fabricated DOM (`page.evaluate` in the worker page) is irrelevant:
 *   the engine reads its OWN page;
 * - mocked responses (`page.route` in the worker) are irrelevant: the
 *   worker cannot route the engine's traffic;
 * - direct API/Node mutations bypass the engine page entirely: no
 *   engine action runs, so no engine-observed action/visible records
 *   exist for them — invented suite-submitted records never satisfy;
 * - HTTP-200-while-error: the engine asserts the rendered status
 *   itself (created/archived values) AND captures the app response
 *   status — a displayed error fails the action fail-closed.
 *
 * Surface selectors are LOCATORS, never proof: a lying descriptor only
 * makes the engine fail to find elements (fail closed).
 */
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response } from 'playwright';
import {
  declaredSurfaceFields,
  renderSurfaceTemplate,
  type SurfaceDescriptor,
} from '../surface.js';

/** The UI operations the engine can perform (constrained subset). */
export type EngineOperation = 'create' | 'read' | 'update' | 'delete';

/** One app-origin exchange the engine captured during an action. */
export interface EngineCapturedExchange {
  /** Uppercase method (GET, POST, ...). */
  method: string;
  /** Canonical observed path (query/fragment stripped). */
  path: string;
  /** Response status the app answered. */
  status: number;
  /** Response body bytes (bounded snapshot for hashing). */
  body: Buffer;
}

/** What the engine observed performing one action. */
export interface EngineActionObservation {
  /** Entity id OBSERVED from the rendered list (never declared). */
  entityId: string;
  /** The exact input values the engine typed (exact-value echo source). */
  enteredFields: Record<string, string>;
  /** The rendered fields the engine read back after the action. */
  renderedFields: Record<string, string>;
  /** App-origin exchanges captured inside the action window. */
  exchanges: EngineCapturedExchange[];
  /** Engine-side pre-observation marker (filled by the witness layer). */
  preObservationId?: string;
}

/** Fail-closed engine browser error (surfaced as 409/503 downstream). */
export class EngineBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineBrowserError';
  }
}

/** The browser launcher the engine drives (default: pinned Chromium). */
export interface EngineBrowserLauncher {
  launch(options?: Record<string, unknown>): Promise<Browser>;
}

/** Bounded wait for a rendered selector (fail closed, never indefinite). */
const ENGINE_STEP_TIMEOUT_MS = 15_000;

/**
 * Owns the engine Chromium instance and its per-session contexts.
 *
 * Args:
 *   launcher: browser launcher (default: the pinned Chromium). Tests
 *     inject a failing launcher to prove the fail-closed path; the
 *     driving and observation below stay engine code regardless of
 *     which executable launches.
 */
export class EngineBrowserManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, { context: BrowserContext; page: Page }>();
  /**
   * Pinned `--host-resolver-rules` value binding every attested hostname
   * to its startup-approved loopback IPs. Set once at witness startup
   * (before any launch); the browser is then incapable of resolving
   * those names anywhere but loopback, regardless of later DNS changes.
   */
  private dnsPinRules: string | null = null;

  constructor(private readonly launcher: EngineBrowserLauncher = chromium) {}

  /**
   * Installs the DNS pin rules for the next (first) launch.
   *
   * Args:
   *   rules: the `--host-resolver-rules` value, or null when nothing is
   *     pinned (plain launch, previous behavior).
   *
   * Throws:
   *   EngineBrowserError: when the browser already launched — pins must
   *   precede every navigation (fail closed, never silently unbound).
   */
  setDnsPinRules(rules: string | null): void {
    if (this.browser !== null || this.launching !== null) {
      throw new EngineBrowserError(
        'DNS pin rules arrive after browser launch: pins must precede every navigation',
      );
    }
    this.dnsPinRules = rules;
  }

  /**
   * Returns the engine page for one session, creating the isolated
   * context on first use.
   *
   * Args:
   *   sessionId: the supervisor-opened session the context belongs to.
   *
   * Returns:
   *   Promise<Page>: the session's engine-owned page.
   *
   * Throws:
   *   EngineBrowserError: when Chromium cannot launch (fail closed —
   *     the capability is honestly unavailable at runtime).
   */
  async pageFor(sessionId: string): Promise<Page> {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing.page;
    const browser = await this.ensureBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    this.sessions.set(sessionId, { context, page });
    return page;
  }

  /**
   * Closes and forgets one session's engine context (session seal).
   * Late engine calls for the session then recreate nothing — callers
   * must refuse sealed sessions before driving (they do: every browser
   * endpoint requires an OPEN session first).
   *
   * Args:
   *   sessionId: the sealed session.
   */
  async closeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    this.sessions.delete(sessionId);
    await entry.context.close().catch(() => undefined);
  }

  /** Closes every engine context and the browser (witness stop). */
  async closeAll(): Promise<void> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(entries.map((entry) => entry.context.close().catch(() => undefined)));
    const browser = this.browser;
    this.browser = null;
    this.launching = null;
    if (browser !== null) await browser.close().catch(() => undefined);
  }

  /** Lazy Chromium launch (single flight; fail closed with the cause). */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser !== null) return this.browser;
    this.launching ??= this.launcher
      .launch({
        headless: true,
        // DNS binding (loopback-pins): attested hostnames resolve ONLY
        // to their startup-approved loopback IPs inside this browser —
        // a mid-run DNS change cannot move its traffic off loopback.
        ...(this.dnsPinRules !== null ? { args: [`--host-resolver-rules=${this.dnsPinRules}`] } : {}),
      })
      .then((browser) => {
        this.browser = browser;
        return browser;
      })
      .catch((error: unknown) => {
        this.launching = null;
        throw new EngineBrowserError(
          `the engine-owned browser cannot launch: ${(error as Error).message} — browser ` +
            'contracts stay blocking until a working Chromium is available to the witness process',
        );
      });
    return this.launching;
  }
}

/** Captures app-origin responses on one page for the action window. */
async function captureExchanges(
  page: Page,
  appOrigin: string,
  action: () => Promise<void>,
): Promise<EngineCapturedExchange[]> {
  const captured: EngineCapturedExchange[] = [];
  // Replacement-origin enforcement (fake-frontend fix 2026-09-14): every
  // URL the engine page touches during the window — main-frame
  // navigations AND every hop of every redirect chain — must stay on the
  // trusted origin. A form submit, link, or redirect landing elsewhere
  // fails the action closed instead of observing a foreign frontend.
  const violations: string[] = [];
  const checkUrl = (url: string, where: string): void => {    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return; // non-URL (about:blank, data:) — the final page.url check covers landing
    }
    if (origin !== appOrigin) violations.push(`${where}: ${url}`);
  };
  // Main-frame navigation guard: page.url() is the main frame's URL,
  // so asserting it on every frame event covers navigations while
  // subresource loads (same URL, no-op) cannot false-positive.
  const mainFrameListener = (): void => {
    const current = page.url();
    if (current.startsWith('about:') || current.startsWith('data:')) return;
    checkUrl(current, 'navigation to foreign origin');
  };
  page.on('framenavigated', mainFrameListener);
  const listener = (response: Response): void => {
    // Walk the full redirect chain: the final URL AND every hop must be
    // same-origin — a 303 to a foreign frontend is rejected even though
    // the 303 itself came from the app. Scoped to redirects and document
    // navigations: plain cross-origin SUBRESOURCES (fonts, icons) are
    // not navigations, never become evidence, and must not false-positive.
    const request = response.request();
    const chain: string[] = [request.url()];
    let previous: unknown = request.redirectedFrom();
    while (previous !== null && typeof previous === 'object' && 'url' in (previous as Record<string, unknown>)) {
      const hop = previous as { url(): string; redirectedFrom(): unknown };
      chain.push(hop.url());
      previous = hop.redirectedFrom();
    }
    const involvedRedirect = chain.length > 1;
    let resourceType = '';
    try {
      resourceType = request.resourceType();
    } catch {
      resourceType = '';
    }
    if (involvedRedirect || resourceType === 'document') {
      for (const url of chain) checkUrl(url, 'redirect chain left the trusted origin');
    }
    let url: URL;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (url.origin !== appOrigin) return;
    const chunks: Buffer[] = [];
    void response
      .body()
      .then((body) => chunks.push(body))
      .catch(() => undefined)
      .finally(() => {
        captured.push({
          method: response.request().method().toUpperCase(),
          path: canonicalExchangePath(url.pathname),
          status: response.status(),
          body: Buffer.concat(chunks).slice(0, 16384),
        });
      });
  };
  page.on('response', listener);
  // The drive's own error (status mismatch, missing row) is recorded
  // but yields to origin violations: a redirect escape is the stronger
  // security signal and must name itself even when the foreign page
  // ALSO fails a rendered check.
  let driveError: unknown = null;
  try {
    await action();
    // Let in-flight response bodies settle (bounded): the mutation's own
    // exchange must be captured before the window closes.
    await page.waitForTimeout(250);
  } catch (error) {
    driveError = error;
  } finally {
    page.off('response', listener);
    page.off('framenavigated', mainFrameListener);
  }
  // Await the pending body reads (bounded by the step timeout overall).
  await page.waitForTimeout(250);
  // The landing itself must be the trusted origin (backstop for
  // navigations that produced no response event).
  checkUrl(page.url(), 'engine page landed on a foreign origin');
  if (violations.length > 0) {
    throw new EngineBrowserError(
      `browser action left the trusted application origin '${appOrigin}': ` +
        `${violations.slice(0, 3).join('; ')} — replacement origins and redirects are rejected; ` +
        'no action record is issued for a foreign frontend',
    );
  }
  if (driveError !== null) throw driveError;
  return captured;
}

/** Canonicalizes an engine-observed path (lockstep with the witness). */
function canonicalExchangePath(pathname: string): string {
  let path = pathname.split('?')[0]?.split('#')[0] ?? '/';
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path;
}

/** Reads one row's cells (trimmed text, DOM order). */
async function rowCells(row: Locator): Promise<string[]> {
  const cells = row.locator('td');
  const count = await cells.count();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(((await cells.nth(i).textContent()) ?? '').trim());
  }
  return out;
}

/** Every entity id rendered in the list right now. */
async function collectIds(page: Page, surface: SurfaceDescriptor): Promise<Set<string>> {
  const rows = page.locator(surface.list.rowSelector);
  const count = await rows.count();
  const ids = new Set<string>();
  for (let i = 0; i < count; i++) {
    const cells = await rowCells(rows.nth(i));
    const id = (cells[surface.list.idCellIndex] ?? '').trim();
    if (id !== '') ids.add(id);
  }
  return ids;
}

/** The rendered row for one entity (null when the UI exposes none). */
async function findRow(page: Page, surface: SurfaceDescriptor, entityId: string): Promise<Locator | null> {
  const rows = page.locator(surface.list.rowSelector);
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const cells = await rowCells(row);
    if ((cells[surface.list.idCellIndex] ?? '').trim() === entityId) return row;
  }
  return null;
}

/** The rendered field values of one row. */
async function readRowFields(
  page: Page,
  surface: SurfaceDescriptor,
  row: Locator,
): Promise<Record<string, string>> {
  void page;
  const cells = await rowCells(row);
  const fields: Record<string, string> = {};
  for (const [name, index] of Object.entries(surface.list.fieldCellIndexes)) {
    fields[name] = (cells[index] ?? '').trim();
  }
  return fields;
}

/** Fills exactly the declared inputs on the current form. */
async function fillFormFields(
  page: Page,
  selectors: Record<string, string>,
  fields: Record<string, string>,
): Promise<void> {
  for (const [name, selector] of Object.entries(selectors)) {
    const value = fields[name];
    if (value === undefined) continue;
    await page.locator(selector).fill(value, { timeout: ENGINE_STEP_TIMEOUT_MS });
  }
}

/** Reads the current form's input values back. */
async function readFormFields(
  page: Page,
  selectors: Record<string, string>,
): Promise<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const [name, selector] of Object.entries(selectors)) {
    fields[name] = await page.locator(selector).inputValue({ timeout: ENGINE_STEP_TIMEOUT_MS });
  }
  return fields;
}

/** Navigates to the list and proves it rendered. */
async function gotoList(page: Page, appBase: string, surface: SurfaceDescriptor): Promise<void> {
  await page.goto(`${appBase}${surface.list.path}`, { timeout: ENGINE_STEP_TIMEOUT_MS });
  await page.waitForSelector(surface.list.readySelector, { timeout: ENGINE_STEP_TIMEOUT_MS });
}

/** Waits for the post-action landing and proves it rendered. */
async function waitAfterAction(page: Page, surface: SurfaceDescriptor): Promise<void> {
  await page.waitForURL((url) => url.pathname === surface.afterAction.path, {
    timeout: ENGINE_STEP_TIMEOUT_MS,
  });
  await page.waitForSelector(surface.list.readySelector, { timeout: ENGINE_STEP_TIMEOUT_MS });
}

/**
 * Drives one constrained surface operation on the engine page and
 * observes every step itself.
 *
 * Args:
 *   page: the session's engine-owned page.
 *   appBase: loopback app base the engine navigates (validated upstream).
 *   surface: the validated consumer descriptor (locators only).
 *   operation: the constrained operation to perform.
 *   input: entered fields (create/update) and/or the target entity id.
 *
 * Returns:
 *   Promise<EngineActionObservation>: the engine's own observation —
 *   observed entity id, entered + rendered fields, captured exchanges.
 *
 * Throws:
 *   EngineBrowserError: fail-closed on every untrusted outcome —
 *   missing rows, ambiguous creation, wrong rendered status, no
 *   application request, or an application error status.
 */
export async function driveEngineAction(
  page: Page,
  appBase: string,
  surface: SurfaceDescriptor,
  operation: EngineOperation,
  input: { fields?: Record<string, string>; entityId?: string },
): Promise<EngineActionObservation> {
  const appOrigin = new URL(appBase).origin;
  try {
    return await driveEngineActionInner(page, appBase, appOrigin, surface, operation, input);
  } catch (error) {
    // Every Playwright failure (timeout, navigation, detached frame) is
    // an engine-observed unsuccessful action — never a 500: the test
    // fails and the gate blocks with the precise cause.
    if (error instanceof EngineBrowserError) throw error;
    throw new EngineBrowserError(`browser.${operation} failed: ${(error as Error).message}`);
  }
}

/** The operation dispatch (wrapped by {@link driveEngineAction}). */
async function driveEngineActionInner(
  page: Page,
  appBase: string,
  appOrigin: string,
  surface: SurfaceDescriptor,
  operation: EngineOperation,
  input: { fields?: Record<string, string>; entityId?: string },
): Promise<EngineActionObservation> {
  switch (operation) {
    case 'create': {
      const fields = declaredSurfaceFields('browser.create', input.fields ?? {}, surface.create.fields);
      let entityId = '';
      let rendered: Record<string, string> = {};
      const exchanges = await captureExchanges(page, appOrigin, async () => {
        await gotoList(page, appBase, surface);
        const before = await collectIds(page, surface);
        await page.goto(`${appBase}${surface.create.formPath}`, { timeout: ENGINE_STEP_TIMEOUT_MS });
        await page.waitForSelector(surface.create.formReadySelector, { timeout: ENGINE_STEP_TIMEOUT_MS });
        await fillFormFields(page, surface.create.fields, fields);
        await page.locator(surface.create.submitSelector).click({ timeout: ENGINE_STEP_TIMEOUT_MS });
        await waitAfterAction(page, surface);
        const created = [...(await collectIds(page, surface))].filter((id) => !before.has(id));
        if (created.length !== 1) {
          throw new EngineBrowserError(
            `browser.create observed ${String(created.length)} new entities, expected exactly one — ` +
              'the rendered outcome is ambiguous, so no action record is issued',
          );
        }
        entityId = created[0] as string;
        const row = await findRow(page, surface, entityId);
        if (row === null) {
          throw new EngineBrowserError(
            `browser.create: the rendered list exposes no row for the created entity ${entityId}`,
          );
        }
        rendered = await readRowFields(page, surface, row);
        if (surface.status.createdValue !== undefined) {
          const shown = rendered[surface.status.field] ?? '';
          if (shown !== surface.status.createdValue) {
            throw new EngineBrowserError(
              `browser.create: entity ${entityId} rendered ${surface.status.field} '${shown}', ` +
                `expected '${surface.status.createdValue}' — the application displays an error state, ` +
                'so the action fails instead of earning proof',
            );
          }
        }
      });
      requireAppRequest(exchanges, 'create');
      return { entityId, enteredFields: fields, renderedFields: rendered, exchanges };
    }
    case 'read': {
      const entityId = input.entityId ?? '';
      if (entityId === '') throw new EngineBrowserError('browser.read requires { entityId }');
      let rendered: Record<string, string> = {};
      const exchanges = await captureExchanges(page, appOrigin, async () => {
        await gotoList(page, appBase, surface);
        const row = await findRow(page, surface, entityId);
        if (row === null) {
          throw new EngineBrowserError(`browser.read: the rendered UI exposes no row for ${entityId}`);
        }
        const edit = row.locator(surface.edit.linkSelector);
        if ((await edit.count()) === 0) {
          throw new EngineBrowserError(
            `browser.read: the rendered UI exposes no navigation control for ${entityId}`,
          );
        }
        await edit.click({ timeout: ENGINE_STEP_TIMEOUT_MS });
        await page.waitForSelector(renderSurfaceTemplate(surface.edit.formReadySelectorTemplate, entityId), {
          timeout: ENGINE_STEP_TIMEOUT_MS,
        });
        rendered = await readFormFields(page, surface.edit.fields);
      });
      return { entityId, enteredFields: {}, renderedFields: rendered, exchanges };
    }
    case 'update': {
      const entityId = input.entityId ?? '';
      if (entityId === '') throw new EngineBrowserError('browser.update requires { entityId }');
      const fields = declaredSurfaceFields('browser.update', input.fields ?? {}, surface.edit.fields);
      let rendered: Record<string, string> = {};
      const exchanges = await captureExchanges(page, appOrigin, async () => {
        await gotoList(page, appBase, surface);
        const row = await findRow(page, surface, entityId);
        if (row === null) {
          throw new EngineBrowserError(`browser.update: the rendered UI exposes no row for ${entityId}`);
        }
        await row.locator(surface.edit.linkSelector).click({ timeout: ENGINE_STEP_TIMEOUT_MS });
        await page.waitForSelector(renderSurfaceTemplate(surface.edit.formReadySelectorTemplate, entityId), {
          timeout: ENGINE_STEP_TIMEOUT_MS,
        });
        await fillFormFields(page, surface.edit.fields, fields);
        await page
          .locator(renderSurfaceTemplate(surface.edit.saveSelectorTemplate, entityId))
          .first()
          .click({ timeout: ENGINE_STEP_TIMEOUT_MS });
        await waitAfterAction(page, surface);
        const updatedRow = await findRow(page, surface, entityId);
        if (updatedRow === null) {
          throw new EngineBrowserError(`browser.update: entity ${entityId} vanished after update`);
        }
        rendered = await readRowFields(page, surface, updatedRow);
      });
      requireAppRequest(exchanges, 'update');
      return { entityId, enteredFields: fields, renderedFields: rendered, exchanges };
    }
    case 'delete': {
      const entityId = input.entityId ?? '';
      if (entityId === '') throw new EngineBrowserError('browser.archive requires { entityId }');
      const deleteFields = { ...surface.deleteFields };
      let rendered: Record<string, string> = {};
      const exchanges = await captureExchanges(page, appOrigin, async () => {
        await gotoList(page, appBase, surface);
        const row = await findRow(page, surface, entityId);
        if (row === null) {
          throw new EngineBrowserError(`browser.archive: the rendered UI exposes no row for ${entityId}`);
        }
        const control = row.locator(renderSurfaceTemplate(surface.archive.controlSelectorTemplate, entityId));
        if ((await control.count()) === 0) {
          throw new EngineBrowserError(
            `browser.archive: entity ${entityId} exposes no archive control (already archived?)`,
          );
        }
        await control.click({ timeout: ENGINE_STEP_TIMEOUT_MS });
        await waitAfterAction(page, surface);
        const archivedRow = await findRow(page, surface, entityId);
        if (archivedRow === null) {
          throw new EngineBrowserError(`browser.archive: entity ${entityId} vanished after archive`);
        }
        rendered = await readRowFields(page, surface, archivedRow);
        if (surface.status.archivedValue !== undefined) {
          const shown = rendered[surface.status.field] ?? '';
          if (shown !== surface.status.archivedValue) {
            throw new EngineBrowserError(
              `browser.archive: entity ${entityId} rendered ${surface.status.field} '${shown}', ` +
                `expected '${surface.status.archivedValue}' — the application displays an error ` +
                'state, so the action fails instead of earning proof',
            );
          }
        }
      });
      requireAppRequest(exchanges, 'delete');
      return { entityId, enteredFields: deleteFields, renderedFields: rendered, exchanges };
    }
  }
}

/**
 * Requires that the action window captured at least one application
 * request that the app did not reject: a rendered click that caused no
 * request (or only error statuses) proves no application behavior.
 *
 * Args:
 *   exchanges: the engine-captured app-origin exchanges.
 *   operation: the performed operation (diagnostic only).
 *
 * Throws:
 *   EngineBrowserError: when no acceptable application request exists.
 */
function requireAppRequest(exchanges: EngineCapturedExchange[], operation: string): void {
  const mutation = exchanges.filter((entry) => entry.method !== 'GET' && entry.method !== 'HEAD');
  if (mutation.length === 0) {
    throw new EngineBrowserError(
      `browser.${operation}: the engine captured no application request for the action — ` +
        'a rendered click that caused no request proves no application behavior',
    );
  }
  const accepted = mutation.find((entry) => entry.status < 400);
  if (accepted === undefined) {
    throw new EngineBrowserError(
      `browser.${operation}: every captured application request was rejected ` +
        `(${mutation.map((entry) => `${entry.method} ${entry.path} → ${String(entry.status)}`).join(', ')}) — ` +
        'the application refused the action, so it fails instead of earning proof',
    );
  }
}

/**
 * Re-reads the rendered result for one entity on the engine page
 * (the `visible.confirm` counterpart): row read for mutations, form
 * read for reads.
 *
 * Args:
 *   page: the session's engine-owned page.
 *   appBase: loopback app base.
 *   surface: the validated consumer descriptor.
 *   operation: the original action (decides row vs form readback).
 *   entityId: the engine-observed entity id.
 *
 * Returns:
 *   Promise<Record<string, string>>: the rendered fields.
 *
 * Throws:
 *   EngineBrowserError: when the UI no longer exposes the entity.
 */
export async function readEngineVisible(
  page: Page,
  appBase: string,
  surface: SurfaceDescriptor,
  operation: EngineOperation,
  entityId: string,
): Promise<Record<string, string>> {
  try {
    await gotoList(page, appBase, surface);
    const row = await findRow(page, surface, entityId);
    if (row === null) {
      throw new EngineBrowserError(`browser.visible: the rendered UI exposes no row for ${entityId}`);
    }
    if (operation === 'read') {
      await row.locator(surface.edit.linkSelector).click({ timeout: ENGINE_STEP_TIMEOUT_MS });
      await page.waitForSelector(renderSurfaceTemplate(surface.edit.formReadySelectorTemplate, entityId), {
        timeout: ENGINE_STEP_TIMEOUT_MS,
      });
      return readFormFields(page, surface.edit.fields);
    }
    return readRowFields(page, surface, row);
  } catch (error) {
    if (error instanceof EngineBrowserError) throw error;
    throw new EngineBrowserError(`browser.visible failed: ${(error as Error).message}`);
  }
}
