/**
 * The engine-generated state registry (plan 20261021_0030_gf_infra_visibility,
 * P3): `supervisor-timing.json` joins the closed-world list — the state
 * dir carries the new always-on timing document next to `failures.json`.
 */
import { describe, expect, it } from 'vitest';
import { ENGINE_GENERATED_STATE_FILES } from './state-artifacts.js';

describe('ENGINE_GENERATED_STATE_FILES (plan 20261021_0030_gf_infra_visibility P3)', () => {
  it('registers supervisor-timing.json as an engine-generated state file', () => {
    expect(ENGINE_GENERATED_STATE_FILES).toContain('supervisor-timing.json');
  });
});
