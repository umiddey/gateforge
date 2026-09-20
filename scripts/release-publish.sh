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
set -euo pipefail
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
