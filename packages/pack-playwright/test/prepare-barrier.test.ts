/**
 * The environment projection behind the global preparation freeze
 * (`src/discovery/prepare-barrier.ts`).
 *
 * The native runner unions every dependency worker's produced environment
 * into its dependents, so the generated controller is the ONE worker whose
 * job is to put its own environment back to the trusted baseline before any
 * body project runs. What the projection must therefore guarantee is a
 * statement about OWN KEYS on both sides, not about names:
 *
 * - a name the prerequisite INTRODUCED is deleted, whatever it is called.
 *   `constructor`, `toString` and `__proto__` are ordinary environment
 *   names a setup project may legitimately assign, and each of them is also
 *   a property every plain object inherits — so a projection that reads the
 *   baseline through inherited lookup reports them as "restored" to an
 *   inherited function/object value and hands the body worker that instead
 *   of deleting it. No prefix restriction could avoid the case, and none is
 *   acceptable: the runner itself spawns workers with arbitrary names.
 * - a name the trusted baseline OWNS is restored to its own value, including
 *   a prototype-named one, including one a prerequisite deleted outright,
 *   and including an empty string as a real baseline value (the declared
 *   type is `Record<string, string>`). The deleted case is the sharp one:
 *   an ordinary object does not merely fail to store an assignment to
 *   `__proto__`, it silently keeps no own key at all.
 * - a name the runner itself owns (`FREEZE_ENV_EXEMPT`) is never touched.
 *
 * The declared types are the whole input contract: `current` may hold
 * `undefined` and `base` holds strings. Nothing here validates anything
 * outside them. Reported name lists are compared as sets: their order is not
 * part of the contract, only their membership.
 *
 * The two reported lists are independent: a projection that restores one
 * baseline-owned name still reports, in the same call, every introduced
 * name it removed — a name the baseline never owned is deleted whatever
 * else was restored alongside it.
 */
import { describe, expect, it } from 'vitest';
import { FREEZE_ENV_EXEMPT, projectBaselineEnv } from '../src/discovery/prepare-barrier.js';

/**
 * Baseline-owned names that are ALSO properties every plain object
 * inherits. The ordinary baseline name has its own control below.
 */
const PROTOTYPE_NAMED = ['__proto__', 'constructor', 'toString'] as const;

/** The reported names, compared as sets: order is not part of the contract. */
function names(reported: readonly string[]): string[] {
  return [...reported].sort();
}

describe('the freeze controller projects its environment back to the trusted baseline', () => {
  it('deletes every introduced name, including the ones a plain object inherits', () => {
    // The ordinary baseline control already carries its baseline value, so
    // this case is about the introduced names alone.
    const current = Object.fromEntries([
      ['ORDINARY_BASELINE', 'trusted-baseline'],
      ['constructor', 'introduced-by-preparation'],
      ['toString', 'introduced-by-preparation'],
      ['__proto__', 'introduced-by-preparation'],
      ['PROBE_INTRODUCED', 'introduced-by-preparation'],
    ]);
    const base = Object.fromEntries([['ORDINARY_BASELINE', 'trusted-baseline']]);

    const projected = projectBaselineEnv(current, base);

    // Inherited prototype properties are not owned baseline values, so an
    // introduced name is deleted rather than "restored" to `Object`, to
    // `Object.prototype.toString` or to `Object.prototype` itself.
    expect(names(projected.deleted)).toEqual(
      names(['constructor', 'toString', '__proto__', 'PROBE_INTRODUCED']),
    );
    expect(projected.restored).toEqual([]);
    for (const name of ['constructor', 'toString', '__proto__', 'PROBE_INTRODUCED']) {
      expect(Object.hasOwn(current, name)).toBe(false);
    }
    // The control kept its value, and the baseline is never written through.
    expect(current['ORDINARY_BASELINE']).toBe('trusted-baseline');
    expect(base['ORDINARY_BASELINE']).toBe('trusted-baseline');
  });

  it('deletes an introduced name whose value the scheduler left undefined', () => {
    // The runner carries a deleted key as `undefined`; the declared type of
    // `current` admits it, so an own entry holding it is still an entry the
    // baseline never had.
    const current: Record<string, string | undefined> = Object.fromEntries([
      ['GONE_BY_PREPARATION', undefined],
      ['__proto__', undefined],
    ]);

    const projected = projectBaselineEnv(current, {});

    expect(names(projected.deleted)).toEqual(names(['GONE_BY_PREPARATION', '__proto__']));
    expect(projected.restored).toEqual([]);
    expect(Object.hasOwn(current, 'GONE_BY_PREPARATION')).toBe(false);
    expect(Object.hasOwn(current, '__proto__')).toBe(false);
  });

  it.each(PROTOTYPE_NAMED)('restores the baseline-owned %s a prerequisite overwrote', (name) => {
    const base = Object.fromEntries([[name, 'trusted-value']]);
    const current = Object.fromEntries([[name, 'introduced-by-preparation']]);

    const projected = projectBaselineEnv(current, base);

    expect(names(projected.restored)).toEqual(names([name]));
    expect(projected.deleted).toEqual([]);
    expect(Object.hasOwn(current, name)).toBe(true);
    expect(current[name]).toBe('trusted-value');
  });

  it.each(PROTOTYPE_NAMED)('creates the baseline-owned %s a prerequisite deleted', (name) => {
    // The prerequisite removed the name entirely, so the projection has to
    // CREATE the own key. On an ordinary object, writing `__proto__` by
    // assignment does not create one at all — the inherited accessor
    // swallows it — so this case is where that shows up. `UNRELATED` is
    // introduced rather than baseline-owned, so the same call has to
    // report removing it too: the two lists are independent.
    const base = Object.fromEntries([[name, 'trusted-value']]);
    const current = Object.fromEntries([['UNRELATED', 'introduced-by-preparation']]);

    const projected = projectBaselineEnv(current, base);

    expect(names(projected.restored)).toEqual(names([name]));
    expect(names(projected.deleted)).toEqual(names(['UNRELATED']));
    expect(Object.hasOwn(current, name)).toBe(true);
    expect(current[name]).toBe('trusted-value');
    expect(Object.hasOwn(current, 'UNRELATED')).toBe(false);
  });

  it('restores an empty-string baseline value, which is a value and not an absence', () => {
    // Neither name is present at all, so this is the create-from-absent
    // boundary for both an ordinary and a prototype-named baseline entry.
    const base = Object.fromEntries([
      ['EMPTY_BASELINE', ''],
      ['__proto__', ''],
    ]);
    const current = Object.fromEntries([['UNRELATED', 'introduced-by-preparation']]);

    const projected = projectBaselineEnv(current, base);

    expect(names(projected.restored)).toEqual(names(['EMPTY_BASELINE', '__proto__']));
    expect(names(projected.deleted)).toEqual(names(['UNRELATED']));
    expect(Object.hasOwn(current, 'EMPTY_BASELINE')).toBe(true);
    expect(current['EMPTY_BASELINE']).toBe('');
    expect(Object.hasOwn(current, '__proto__')).toBe(true);
    expect(current['__proto__']).toBe('');
  });

  it('restores an ordinary overwritten name and deletes an ordinary introduced one', () => {
    const current = Object.fromEntries([
      ['ORDINARY_BASELINE', 'introduced-by-preparation'],
      ['ORDINARY_INTRODUCED', 'introduced-by-preparation'],
    ]);
    const base = Object.fromEntries([['ORDINARY_BASELINE', 'trusted-baseline']]);

    const projected = projectBaselineEnv(current, base);

    expect(projected.restored).toEqual(['ORDINARY_BASELINE']);
    expect(projected.deleted).toEqual(['ORDINARY_INTRODUCED']);
    expect(current['ORDINARY_BASELINE']).toBe('trusted-baseline');
    expect(Object.hasOwn(current, 'ORDINARY_INTRODUCED')).toBe(false);
  });

  it('never touches the names the runner itself owns, whatever the baseline claims', () => {
    const runnerValues = Object.fromEntries(
      FREEZE_ENV_EXEMPT.map((name, index) => [name, `runner-owned-${String(index)}`]),
    );
    // The baseline OWNS all four with a different value, so this case is
    // the exemption against a baseline that would otherwise restore them.
    const base = Object.fromEntries(FREEZE_ENV_EXEMPT.map((name) => [name, 'baseline-says-otherwise']));
    const current = Object.fromEntries([
      ...Object.entries(runnerValues),
      ['PROBE_INTRODUCED', 'introduced-by-preparation'],
    ]);

    const projected = projectBaselineEnv(current, base, FREEZE_ENV_EXEMPT);

    // An exemption is neither restored nor deleted, whatever the baseline
    // says: the runner writes these into every worker, so projecting them
    // would report a change no prerequisite made.
    expect(projected.restored).toEqual([]);
    expect(projected.deleted).toEqual(['PROBE_INTRODUCED']);
    for (const [name, value] of Object.entries(runnerValues)) {
      expect(Object.hasOwn(current, name)).toBe(true);
      expect(current[name]).toBe(value);
    }
  });
});
