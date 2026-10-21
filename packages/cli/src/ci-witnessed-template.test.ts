/**
 * The witnessed CI lanes upload the near-budget timing document (plan
 * 20261021_0030_gf_infra_visibility, P3): both generated templates carry
 * `.gateforge/test-gates/supervisor-timing.json` beside `failures.json`
 * — it is secret-screened aggregate timing, never a request body.
 */
import { describe, expect, it } from 'vitest';
import { renderGitlabWitnessedTemplate, renderGithubWitnessedTemplate } from './ci-witnessed-template.js';

describe('witnessed CI templates (plan 20261021_0030_gf_infra_visibility P3)', () => {
  it('upload supervisor-timing.json from both lanes', () => {
    for (const template of [renderGitlabWitnessedTemplate(), renderGithubWitnessedTemplate()]) {
      expect(template).toContain('.gateforge/test-gates/supervisor-timing.json');
    }
  });
});
