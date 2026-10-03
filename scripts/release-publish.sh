#!/usr/bin/env bash
# Idempotent workspace publisher for the release workflow.
#
# For each workspace package: if its exact version is already on the
# registry, skip (safe re-runs, partial rollouts); otherwise publish with
# A partial publish is a broken release: a fresh install of the CLI can
# resolve one workspace while its same-version dependencies are absent.
# Fail the workflow so release automation cannot report a false green.
#
# Every package must have its npm Trusted Publisher configured before tagging.
#
# Bytecode preflight: publishing straight from a working tree where the Python
# detectors have run shipped every `python/**/__pycache__/*.pyc` into the
# tarballs (0.8.0 did, in four packages). Every manifest that ships a `python`
# directory now ends its `files` list with the negations `!**/__pycache__`,
# `!**/*.pyc` and `!**/*.pyo`, and the preflight below refuses the whole
# release — before a single package is published — when a packed file list
# still names bytecode, printing the package and the path. Release through the
# tag workflow (.github/workflows/publish.yml) or from the `.tgz` files a
# `npm pack --dry-run --json --workspaces` just verified; a manual
# `npm publish` from a used working tree is not a release path.
#
# Usage: `bash scripts/release-publish.sh` publishes; `bash
# scripts/release-publish.sh check` runs the same tarball preflight and stops
# there. Root package.json's `publish:all` and `pack:check` both route through
# this script, so neither can publish a tarball the preflight refused.
set -euo pipefail

mode="${1:-publish}"
if (( $# > 1 )) || [[ "$mode" != "publish" && "$mode" != "check" ]]; then
  echo "usage: bash scripts/release-publish.sh [publish|check]" >&2
  exit 2
fi

# Packed file lists of every workspace package, one "<package>: <path>" line
# per Python bytecode entry. Exit 3: bytecode found. Exit 1: the list could not
# be read (npm failed, printed no JSON, or packed no package). Both refuse.
pack_bytecode_offenders() {
  npm pack --dry-run --json --workspaces | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  let entries;
  try {
    entries = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    console.error(`npm pack --dry-run --json printed no JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    console.error("npm pack --dry-run --json packed no workspace package — run it from the repository root");
    process.exit(1);
  }
  const offenders = [];
  for (const entry of entries) {
    const name = typeof entry.name === "string" ? entry.name : "unknown package";
    for (const file of entry.files ?? []) {
      const path = typeof file.path === "string" ? file.path : "";
      if (/(^|\/)__pycache__(\/|$)/.test(path) || /\.(pyc|pyo)$/.test(path)) {
        offenders.push(`${name}: ${path}`);
      }
    }
  }
  if (offenders.length > 0) {
    console.log(offenders.join("\n"));
    process.exit(3);
  }
});
'
}

preflight_log=$(mktemp -d)
trap 'rm -rf "$preflight_log"' EXIT
bytecode_status=0
bytecode_offenders=$(pack_bytecode_offenders 2>"$preflight_log/npm.err") || bytecode_status=$?
if (( bytecode_status == 3 )); then
  echo "::error::refusing to publish: Python bytecode would ship in these tarballs"
  while IFS= read -r offender; do echo "       $offender"; done <<< "$bytecode_offenders"
  echo "       fix: end that package's files list with !**/__pycache__, !**/*.pyc and !**/*.pyo, delete the cache, then re-run"
  exit 1
elif (( bytecode_status != 0 )); then
  echo "::error::refusing to publish: the packed file list could not be verified"
  sed 's/^/       /' "$preflight_log/npm.err"
  exit 1
fi
echo "::notice::tarball preflight: no Python bytecode in any workspace package"
if [[ "$mode" == "check" ]]; then
  echo "::notice::check mode: the packed file lists are clean; nothing was published"
  exit 0
fi
published=0; skipped=0; failed=0
for dir in packages/*/; do
  name=$(node -p "require('./${dir}package.json').name")
  version=$(node -p "require('./${dir}package.json').version")
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "::notice::$name@$version already on the registry — skipped"
    skipped=$((skipped + 1))
    continue
  fi
  if npm publish -w "$dir" --provenance; then
    echo "::notice::published $name@$version"
    published=$((published + 1))
  else
    echo "::warning::$name@$version FAILED to publish — check its Trusted Publisher settings on npmjs.com"
    failed=$((failed + 1))
  fi
done
echo "publish summary: $published published, $skipped skipped, $failed failed"
if (( failed > 0 )); then
  echo "::error::$failed workspace package(s) failed to publish; release is incomplete"
  exit 1
fi
