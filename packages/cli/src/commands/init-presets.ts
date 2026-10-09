/**
 * The goal-based `init` presets: ONE table that maps what the owner wants
 * to the exact settings init writes.
 *
 * `gateforge init` asks one goal question — light / normal / strict — and
 * this table is the only place that says what a goal means, so
 * `init --explain-presets` and the interactive summary can never drift
 * apart.
 *
 * Rules this table obeys (hard):
 * - It never writes a waiver (an owner-signed "this is fine"), an adopted
 *   baseline (a list of debt the owner accepted), or a suppressive plane
 *   declaration (a rule that hides code from the gate).
 * - It only sets the GATE, never the EVIDENCE: a preset never turns off a
 *   detector and never makes a missing proof look proven.
 * - The `mode` key is the owner-owned strictness key (strictness.ts); an
 *   ABSENT key means `strict`, so omitting it preserves the frozen
 *   behavior byte for byte.
 */
import type { StrictnessMode } from '@gate-forge/core';

/** The three goals `gateforge init` offers, in the order it asks them. */
export const INIT_PRESET_NAMES = ['light', 'normal', 'strict'] as const;

/** Inferred preset-name union (`--preset light|normal|strict`). */
export type InitPresetName = (typeof INIT_PRESET_NAMES)[number];

/** Everything one goal means: the config key and the wiring init applies. */
export interface InitPresetSettings {
  /** The owner-owned `mode` key written into `.gateforge.yml`. */
  strictnessMode: StrictnessMode;
  /** Write the enforcement block with `strictE2E: true`. */
  strictE2E: boolean;
  /**
   * The `http.responseShape` the goal writes (0.14 WP4): `report` shows
   * body-shape mismatches as advisories, `block` makes them fail the gate.
   */
  responseShape: 'report' | 'block';
  /**
   * How much gate wiring the goal implies:
   * - `none` — no hook at all; the report is the product.
   * - `pre-commit` — a fast static hook over the files you touched.
   * - `blocking` — the staged gate, a server check, and a pre-push
   *   receipt (the signed record of a witnessed test run).
   */
  wiring: 'none' | 'pre-commit' | 'blocking';
  /** The pre-commit execution mode the hook runs. */
  mode: 'changed' | 'staged';
  /** Write the `.gitlab-ci.yml` include + job template. */
  ci: boolean;
  /** One short sentence a newcomer can act on, with a tiny example. */
  explanation: string;
}

/**
 * The mapping: goal -> settings. Single source of truth for
 * `--preset`, the interactive question, and `--explain-presets`.
 */
export const INIT_PRESETS: Readonly<Record<InitPresetName, InitPresetSettings>> = Object.freeze({
  light: {
    strictnessMode: 'warn',
    strictE2E: false,
    responseShape: 'report',
    wiring: 'none',
    mode: 'changed',
    ci: false,
    explanation:
      'light: show me code nothing has proven yet, block nothing. Example: you add GET /orders with no test — the report lists it, and your commit still goes through.',
  },
  normal: {
    strictnessMode: 'changed',
    strictE2E: false,
    responseShape: 'report',
    wiring: 'pre-commit',
    mode: 'changed',
    ci: true,
    explanation:
      'normal: block a commit that adds untested endpoints or models, in about a second (a static check, no test run). Example: you add a model with no test — that commit is refused; old untested code stays visible in the report.',
  },
  strict: {
    strictnessMode: 'strict',
    strictE2E: true,
    responseShape: 'block',
    wiring: 'blocking',
    mode: 'staged',
    ci: true,
    explanation:
      'strict: every push needs a real test run that Gateforge watches (the WITNESS) plus a RECEIPT — the signed record of that run. Example: `gateforge test-gates` runs your suite under the witness and stores the receipt; a push without a fresh receipt is refused.',
  },
});

/**
 * Type guard for a `--preset` value.
 *
 * Args:
 *   value (unknown): the raw flag value.
 *
 * Returns:
 *   boolean: true when the value names one of the three presets.
 */
export function isInitPresetName(value: unknown): value is InitPresetName {
  return typeof value === 'string' && (INIT_PRESET_NAMES as readonly string[]).includes(value);
}

/**
 * The lines `init --explain-presets` prints: every goal, what it writes,
 * and what it means. Pure so the printed table is unit-testable.
 *
 * Args:
 *   none.
 *
 * Returns:
 *   string: the multi-line preset table.
 */
export function renderPresetTable(): string {
  const lines: string[] = [
    'What each init preset does (the same table the goal question uses):',
    '',
  ];
  for (const name of INIT_PRESET_NAMES) {
    const preset = INIT_PRESETS[name];
    lines.push(`  ${name} — ${preset.explanation}`);
    const writes = [`mode: ${preset.strictnessMode}`];
    if (preset.strictE2E) writes.push('enforcement.strictE2E: true');
    if (preset.wiring !== 'none') writes.push(`pre-commit hook (gateforge check --${preset.mode})`);
    if (preset.wiring === 'blocking') writes.push('pre-push receipt check');
    if (preset.ci) writes.push('.gitlab-ci.yml job');
    lines.push(`      writes: ${writes.join(' + ')}`);
  }
  lines.push('');
  lines.push(
    'An OBLIGATION is one thing your policies say must be proven (e.g. "this endpoint really stores what it receives").',
  );
  lines.push(
    'A preset only chooses how hard the gate blocks; it never waives an obligation and never hides code from the scan.',
  );
  lines.push('Change it later by editing the `mode:` key in .gateforge.yml, then re-running `gateforge init --explain-presets`.');
  return lines.join('\n');
}

/**
 * The goal question itself: one question, three choices, one line of
 * meaning each. Returned as a string so the wording is testable without
 * a terminal.
 *
 * Args:
 *   none.
 *
 * Returns:
 *   string: the block init prints before reading the answer.
 */
export function renderGoalQuestion(): string {
  return [
    '',
    'What should Gateforge do for you?',
    '  1) light  - show me code nothing has proven yet, block nothing',
    '  2) normal - block a commit that adds untested endpoints or models (about a second)',
    '  3) strict - every push needs a real test run Gateforge watches, plus a receipt',
    'Your choice [2]:',
  ].join('\n');
}

/**
 * Parses the answer to the goal question.
 *
 * Args:
 *   answer (string): what the owner typed.
 *
 * Returns:
 *   InitPresetName: the chosen goal; an empty answer takes `normal`.
 *
 * Throws:
 *   Error: when the answer names no goal.
 */
export function parseGoalAnswer(answer: string): InitPresetName {
  const value = answer.trim().toLowerCase();
  if (value === '' || value === '2') return 'normal';
  if (value === '1') return 'light';
  if (value === '3') return 'strict';
  if (isInitPresetName(value)) return value;
  throw new Error(`init: '${answer.trim()}' is not a goal — answer 1 (light), 2 (normal) or 3 (strict)`);
}

/**
 * How a headless owner changes the goal this run could not ask for.
 * Printed as part of the ONE line that names the written preset, so
 * the choice is stated once and the way to change it travels with
 * it. The remedy is the EDIT, never a `--preset` re-run: the run
 * just wrote (or already had) `.gateforge.yml`, and init never
 * rewrites an existing config — a re-run exits 2.
 */
export const CHOOSE_ANOTHER_GOAL_ADVICE =
  'a human must choose the goal: edit `mode:` in .gateforge.yml ' +
  '(light: `mode: warn`, normal: `mode: changed`, strict: `mode: strict`) ' +
  '— in a terminal, `gateforge init` asks';

/**
 * What this init run actually did, as the summary needs to report it.
 *
 * A preset describes what a FRESH repo gets. On an existing repo the
 * same words would be false — the run may have written no config, no
 * hook and no CI file at all — so the summary is driven by what
 * happened here, not by what the preset would have done.
 */
export interface PresetRunOutcome {
  /** True when `.gateforge.yml` already existed and was left alone. */
  configExisted: boolean;
  /** Repo-relative posix paths this run CREATED (the undo list). */
  created: readonly string[];
  /**
   * Repo-relative posix paths this run CHANGED IN PLACE — an appended
   * CI include, an appended pre-commit entry, an added ignore rule.
   * These are the owner's own files: the undo for them is a restore,
   * never a delete.
   */
  modified: readonly string[];
  /** True when the repo already had a commit hook before this run. */
  repoHasCommitHook: boolean;
  /** True when the repo already had a CI file before this run. */
  repoHasCi: boolean;
  /**
   * True when no human was there to choose: the run wrote the light
   * goal and already said so (with the flag that changes it), so the
   * summary does not state the choice a second time. What the run
   * wrote is still reported.
   */
  autoChosen?: boolean;
}

/** Repo-relative predicate: the commit-hook files a preset would wire. */
function isHookPath(path: string): boolean {
  return path.startsWith('.git/hooks/') || path === '.pre-commit-config.yaml';
}

/** One hook claim: what this run did, never what the preset would do. */
function hookLine(preset: InitPresetSettings, outcome: PresetRunOutcome): string {
  const wroteHook = outcome.created.some(isHookPath);
  if (preset.wiring === 'none') {
    // "Nothing blocks your commits" is a claim about the REPO. When the
    // repo already has a commit hook or a CI job, something does, and
    // this run changed neither.
    return outcome.repoHasCommitHook || outcome.repoHasCi
      ? 'wrote no hooks: your existing commit hook and/or CI job (left untouched) still decide ' +
          'what blocks your commits — this run changed neither'
      : 'wrote no hooks: nothing blocks your commits — read the report instead';
  }
  if (!wroteHook) {
    return `kept the commit hook already in place (this run created none) — it still runs gateforge check --${preset.mode}`;
  }
  return preset.wiring === 'pre-commit'
    ? `wrote a pre-commit hook: gateforge check --${preset.mode} (fast, static — no test run)`
    : `wrote the staged gate (gateforge check --${preset.mode}) plus a pre-push receipt check`;
}

/**
 * The summary init prints after a preset is applied: what THIS run
 * wrote, what it deliberately kept, and the command that undoes only
 * what it created. Pure so the wording is unit-testable.
 *
 * The `undo:` line is the dangerous one: it names files, so on an
 * existing repo it must name only the paths this run brought into
 * existence. When it created nothing the line is omitted entirely —
 * there is nothing to undo, and a fixed list would delete the owner's
 * own config, baselines, waivers, hooks and CI file.
 *
 * Args:
 *   name (InitPresetName): the goal that was applied.
 *   outcome (PresetRunOutcome): what this run created and what it kept.
 *
 * Returns:
 *   string[]: the summary lines, in print order.
 */
export function renderPresetSummary(name: InitPresetName, outcome: PresetRunOutcome): string[] {
  const preset = INIT_PRESETS[name];
  const lines = outcome.autoChosen ? [] : [`preset ${name}: ${preset.explanation}`];
  if (outcome.configExisted) {
    lines.push(
      'existing .gateforge.yml left untouched — its `mode:` key still decides how hard the gate blocks; ' +
        'edit it by hand to switch goals',
    );
  } else {
    lines.push(`wrote mode: ${preset.strictnessMode} (strict — block everything / changed — block only what this change touches / warn — block nothing)`);
  }
  lines.push(hookLine(preset, outcome));
  if (preset.ci) {
    // One truth per run: a file this run WROTE, one it appended to, and
    // one it left alone are three different facts, and printing
    // "updated …" followed by "kept … this run created none" read as a
    // contradiction about the same file.
    lines.push(
      outcome.created.includes('.gitlab-ci.yml')
        ? 'wrote the .gitlab-ci.yml include + job'
        : outcome.modified.includes('.gitlab-ci.yml')
          ? 'added the gateforge include to your existing .gitlab-ci.yml (undo: git restore -- .gitlab-ci.yml)'
          : 'kept the .gitlab-ci.yml already in place (this run created none)',
    );
  }
  if (outcome.created.length > 0) {
    lines.push(`undo: rm -rf ${outcome.created.join(' ')}`);
  }
  if (outcome.modified.length > 0) {
    lines.push(`undo: git restore -- ${outcome.modified.join(' ')}`);
  }
  return lines;
}
