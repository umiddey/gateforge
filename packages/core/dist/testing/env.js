/**
 * Injected environment for fixture runs (fixture harness, G7).
 *
 * `withEnv` scopes process.env mutations to a function body (CI provider
 * variables like `GITHUB_BASE_REF` are environment-carried, so fixtures
 * must be able to fake them without leaking). The changed-file provider
 * stubs give GF-09-style parity tests identical inputs through the
 * `local-staged`, `github-pr`, and `gitlab-mr` provider identities.
 */
import { compareStrings } from '../graph/index.js';
/**
 * Runs `body` with a patched `process.env`, restoring the previous
 * environment on every path (sync throw, async rejection, success).
 * A `undefined` value deletes the variable for the body's duration.
 *
 * Args:
 *   vars: variable name to value (or undefined to unset).
 *   body: closure to run under the patched environment; may be async.
 *
 * Returns:
 *   The body's return value (awaited when async).
 */
export function withEnv(vars, body) {
    const saved = new Map();
    for (const [name, value] of Object.entries(vars)) {
        saved.set(name, process.env[name]);
        if (value === undefined) {
            delete process.env[name];
        }
        else {
            process.env[name] = value;
        }
    }
    const restore = () => {
        for (const [name, value] of saved) {
            if (value === undefined) {
                delete process.env[name];
            }
            else {
                process.env[name] = value;
            }
        }
    };
    let result;
    try {
        result = body();
    }
    catch (error) {
        restore();
        throw error;
    }
    if (result instanceof Promise) {
        return result.finally(restore);
    }
    restore();
    return result;
}
/**
 * Normalizes a changed-file list: posix separators, deduplicated,
 * codepoint-sorted. Provider outputs are compared as sets by GF-09.
 *
 * Args:
 *   files: raw provider output.
 *
 * Returns:
 *   string[]: canonical form.
 */
export function normalizeChangedFiles(files) {
    const unique = new Set();
    for (const file of files) {
        unique.add(file.split('\\').join('/'));
    }
    return [...unique].sort(compareStrings);
}
/**
 * Builds a fake changed-file provider from an explicit list — the CI
 * stand-in (`github-pr` / `gitlab-mr` merge-base diff) and the
 * `all-files` full-scan provider for fixtures. The list is snapshotted
 * (defensive copy + normalization) at construction.
 *
 * Args:
 *   provider: provider identity this fake impersonates.
 *   files: raw changed-file list.
 *
 * Returns:
 *   ChangedFileProvider: deterministic, offline, network-free.
 */
export function fakeProvider(provider, files) {
    const snapshot = normalizeChangedFiles(files);
    return { provider, changedFiles: () => [...snapshot] };
}
/**
 * Real `local-staged` provider over a {@link TempRepo}: reads the
 * repository's actual index (`git diff --cached --name-only`) at call
 * time, so fixtures exercise the genuine local half of GF-09 parity.
 *
 * Args:
 *   repo: the fixture repository.
 *
 * Returns:
 *   ChangedFileProvider: staged files, freshly read on every call.
 */
export function localStagedProvider(repo) {
    return { provider: 'local-staged', changedFiles: () => repo.stagedFiles() };
}
//# sourceMappingURL=env.js.map