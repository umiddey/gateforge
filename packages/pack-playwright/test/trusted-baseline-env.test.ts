/**
 * The TRUSTED BASELINE the global preparation freeze projects back to
 * (`src/discovery/runner-env.ts`).
 *
 * `buildRunnerChildEnv` builds the map the supervised runner child starts
 * with, and the freeze arms that very map as the baseline its controller
 * projects to — so a name this builder loses is a name no body worker can
 * ever be projected back to, and a body worker instead keeps whatever the
 * preparation wrote.
 *
 * The case is arbitrary NAME, not exotic content: `constructor`, `toString`
 * and `__proto__` are valid environment names that any setup project may
 * assign, and each of them is also a property every plain object inherits.
 * A builder that tests a candidate with an inherited lookup
 * (`child[name] === undefined`) or assigns onto a plain object therefore
 * drops them silently, while the allowlisted and pass-through names survive
 * — so both ordinary controls are asserted here as well, and a fix cannot
 * pass by breaking everything else.
 *
 * Nothing here widens the allowlists or touches the secret/parent-side
 * guards (covered by `runner-browsers-cache.test.ts` and
 * `witnessed-pytest.test.ts`), and the wrapper that reaches this builder for
 * the freeze is covered end to end by the compiled throwaway probe and the
 * real CLI run, not by a forwarding assertion here.
 */
import { describe, expect, it } from 'vitest';
import { buildRunnerChildEnv } from '../src/discovery/runner-env.js';

/** Supervisor-supplied run variables, all non-secret strings. */
const SUPPLIED = Object.fromEntries([
  ['__proto__', 'trusted-proto'],
  ['constructor', 'trusted-ctor'],
  ['toString', 'trusted-toString'],
  ['GATEFORGE_APP_BASE_URL', 'https://app.example.invalid'],
  ['PROBE_TRUSTED_VAR', 'trusted-ordinary'],
]);

describe('the supervised runner child keeps every name the supervisor supplied', () => {
  it('carries prototype-named run variables into the child environment as own keys', () => {
    // An empty ambient environment: nothing here can come from anywhere but
    // the supervisor-supplied map.
    const child = buildRunnerChildEnv(SUPPLIED, {});

    // The prototype-named entries and both ordinary controls (one
    // allowlisted, one pass-through) are equally owned baseline values.
    for (const [name, value] of Object.entries(SUPPLIED)) {
      expect(Object.hasOwn(child, name)).toBe(true);
      expect(child[name]).toBe(value);
    }
  });

  it('crosses no name the supervisor did not supply, and inherits no prototype property', () => {
    const child = buildRunnerChildEnv(
      { PROBE_TRUSTED_VAR: 'trusted-ordinary' },
      { SOME_AMBIENT_TOKEN: 'ambient-only' },
    );

    // The allowlist is not a wholesale merge: an ambient name that is not
    // allowlisted and not supplied does not cross.
    expect(Object.keys(child)).toEqual(['PROBE_TRUSTED_VAR']);
    // The record itself has no prototype, so a body worker reading
    // `env.constructor` or `env.__proto__` gets nothing — never the
    // inherited `Object` or `Object.prototype` that would otherwise be
    // indistinguishable from a baseline value the run supplied.
    expect(child['constructor']).toBeUndefined();
    expect(child['__proto__']).toBeUndefined();
  });
});
