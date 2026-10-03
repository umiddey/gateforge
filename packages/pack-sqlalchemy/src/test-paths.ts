/**
 * The one generic rule for "this path is test fixture surface, not
 * business surface", shared by everything in this pack and by the CLI's
 * plane-proposal steps.
 *
 * WHY it exists (problem 14): `gateforge init` already refused to infer
 * a business plane for a table declared under a test directory, but the
 * RESOURCE GRAPH still ingested those tables. A test module that declares
 * a fixture table with the same name as a real one (a very common pytest
 * pattern) then collided with it, and the real resource became
 * plane-unresolved or unclassified — a blocking entry with no honest
 * answer. A fixture is not business surface: it never carries the plane
 * of the table it copies, so it must not enter the graph at all.
 *
 * The rule is deliberately the narrowest one that covers the convention:
 * a path is test surface when ANY of its DIRECTORY segments is exactly
 * `test` or `tests` (case-insensitive). It is segment-exact, never a
 * string prefix — `contest/` and `tests_old/` are business surface, and
 * so is a file merely NAMED `test_foo.py` next to real models. The
 * detector in `python/gateforge_sqlalchemy_detector/scan.py` applies the
 * identical segment rule; the two must stay in step, which
 * `test/test-directory-models.test.ts` pins by scanning one repo through
 * both.
 */

/** Directory segments that mark test fixture surface (exact segment match). */
export const TEST_PATH_SEGMENTS: readonly string[] = Object.freeze(['tests', 'test']);

/**
 * Whether a repo-relative posix path names test fixture surface.
 *
 * Args:
 *   source: Repo-root-relative source path of a resource or route
 *     (backslashes accepted and normalized).
 *
 * Returns:
 *   boolean: true when any directory segment of the path is `test` or
 *     `tests` (case-insensitive); false for everything else, including
 *     the repository root and files whose NAME merely starts with `test`.
 */
export function isTestSourcePath(source: string): boolean {
  const segments = source
    .replaceAll('\\', '/')
    .split('/')
    // The last segment is the file name itself; only DIRECTORY segments
    // decide, so `models/test_accounts.py` is not test surface while
    // `tests/models.py` is.
    .slice(0, -1);
  return segments.some((segment) =>
    TEST_PATH_SEGMENTS.includes(segment.toLowerCase()),
  );
}