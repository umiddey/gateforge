#!/usr/bin/env bash
# Idempotent workspace publisher for the release workflow.
#
# For each workspace package: if its exact version is already on the
# registry, skip (safe re-runs, partial rollouts); otherwise publish with
# provenance. A package whose Trusted Publisher is not configured yet (or
# any other per-package failure) is a loud WARNING, not a run failure —
# while the 13 packages are being configured incrementally. Flip the
# `warn` branch to a hard failure once every package automates cleanly.
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
