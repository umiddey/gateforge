# 20260919_1544_endpoint_behavior_and_trust_megaplan
**Task**: Implement and audit the endpoint-behavior and protected-enforcement megaplan.
**Status**: HOST BOOTSTRAP COMPLETE / EXTERNAL ACCEPTANCE PENDING

## WHAT
- Managed isolation now launches an owner-approved immutable Podman profile with fixed arguments before authoritative inspection.
- Managed validation requires exactly three mounts: `/engine` read-only, `/candidate` read-only, and `/app-state` writable; sources must match the requested canonical paths.
- Validation rejects duplicate/extra mounts, path aliases, host home/Git paths, container-management sockets, root identities, invalid network, wrong image, and unrelated controller containers.
- Exited detached controllers are auto-removed with `--rm`; local-unisolated mode never invokes Podman.
- Receipts bind authenticated executed behavior-case digests; task/webhook/workflow dispatch uses the semantic required-case grader.
- The canonical behavior fixture, strict GitHub job mechanism, and digest-pinned controller asset are committed and verified.

## HOW
- Added an injected `PodmanRunner` seam for deterministic contract tests.
- Managed launch uses fixed `podman run --rm --detach --name gateforge-managed-controller --label gateforge.role=controller --read-only --user gateforge-runner --network private` plus exactly three request-bound volumes and an owner-supplied `@sha256` image; no shell, command, or candidate environment is accepted.
- Inspection filters the fixed controller name, then checks immutable image, user, network, socket visibility, mount count/targets/sources/modes, and canonical paths.
- Shared socket detection rejects both Docker and Podman socket substrings, including rootless `/run/user/<uid>/podman/podman.sock` paths.
- Full workspace build/typecheck and browser-enabled regression suite were rerun after the isolation changes.

## WHY
- The previous audit found two real source gaps: managed mode only inspected an existing controller, and mount validation allowed extra mounts or wrong host sources.
- A profile launch must be authority-owned and fixed-argument; inspection alone cannot establish that the requested candidate, engine, and app-state paths were the ones mounted.
- Exact mount validation prevents hidden host capabilities from entering the candidate boundary.
- The receipt boundary digest remains a profile-class digest, while the inspected mount/image facts are independently validated before sealing; the comment no longer overstates what the digest hashes.
- Repository checks cannot prove owner-controlled host isolation, branch protection, publisher enforcement, approved image selection, or a real multipart browser channel.

## FILES MODIFIED
- `packages/cli/src/isolation.ts`: fixed managed launch, authoritative inspection, exact mount/source validation, socket/root hardening.
- `packages/cli/test/isolation.test.ts`: 17 focused boundary, launch, mismatch, and fail-closed tests.

- `docs/plans/immediate/20260919_1544_endpoint_behavior_and_trust_megaplan.md`: corrected status and fresh verification record.
- Earlier audit files remain recorded in the plan and mapped memory: receipt binding, Phase 8 dispatch, canonical fixture, strict GitHub job, and digest-pinned container.

## NEXT SESSION
- Run B53-B58 on an owner-managed rootless-Podman/protected-host environment and record candidate/base/tree IDs, check URLs, rejection causes, and ref state.
- Provision branch protection/required check, owner-controlled workflow/ruleset, protected secrets, publisher restrictions, and the approved Fedora digest.
- Add a real bounded multipart engine/browser channel before claiming spreadsheet UI proof.
- Resolve the canonical fixture's three missing behavior obligations and twelve ancillary endpoint declaration/resource-link blockers through explicit owner-reviewed configuration; do not self-waive them.

## REFERENCES
- Plan: `docs/plans/immediate/20260919_1544_endpoint_behavior_and_trust_megaplan.md`
- Verification: `npm run build` pass; `npm run typecheck` pass; serial `npm test -- --maxWorkers=1` pass (149 files, 1,821 tests); focused controller/isolation suite pass (20 tests); CLI typecheck pass; `git diff --check` pass.
- Consumer verification: `example/behavior/npm test` pass; `gateforge tests suggest --json` exit 0 with three obligations and zero mapping problems; `gateforge check --format json` exit 1 with three missing behavior obligations and twelve ancillary endpoint declaration/resource-link blockers.
- Host limitation: `command -v podman` produced no output; managed host acceptance remains external.
- `docs/testing/TESTING_POLICY.md`

## FRESH PROBE
- The stale-controller bug is fixed. `resolveIsolation` rejects every non-zero `podman run` before inspection, requires one valid 12–64 hexadecimal launch ID, and passes that exact ID directly to `podman inspect`; launched paths never fall back to same-name discovery.
- The managed image now starts the explicit fixed `controller` command. `gateforge controller` writes atomic health/heartbeat state to fixed `/app-state/controller-health.json`, refreshes every five seconds, and records clean SIGTERM/SIGINT shutdown; it never executes candidate commands.
- Regression coverage includes status 125 with a stale same-name controller, exact-ID inspection, malformed launch IDs, both signal paths, fixed `controller` argv, and the Containerfile `CMD ["controller"]`.
- Final verification passes: build, workspace typecheck, serial full workspace suite (149 files, 1,821 tests), focused controller/isolation suite (20 tests), canonical fixture checks, and diff hygiene. Podman host acceptance remains external.

## GATEFORGE-MANAGED BOOTSTRAP
- User decision: no separate installation command. Extend existing `gateforge init` with explicit `--managed`; plain `init` remains local and does not install Podman.
- Managed init must detect Podman, invoke the native host package manager with fixed argv and inherited terminal approval, verify rootless `podman info`, then write managed config only after verification.
- No npm lifecycle script, candidate-controlled config, or silent privilege escalation may install host software.
- The property-management repository now points at the current local CLI through `@gate-forge/cli: file:../gateforge/packages/cli` for integration testing; its Gateforge check runs but reports existing repository obligations.


## GATEFORGE-MANAGED BOOTSTRAP COMPLETION
- `packages/cli/src/podman-bootstrap.ts` now owns Podman detection, native Linux package-manager installation, and rootless verification through fixed argv and an injected test runner.
- Existing `gateforge init` is the only setup entry point: explicit `--managed` installs/verifies Podman before writes, implies blocking wiring, writes strict managed enforcement, and migrates an existing config only when explicitly requested.
- Focused tests cover pacman/dnf selection, targeted-first ordering, explicit upgrade approval/refusal, rootless failures, unsupported platforms, first managed init, and existing-config migration.
- CLI help and `packages/cli/README.md` document the owner-approved installation flow; no npm lifecycle or silent sudo path exists.
- Build, typecheck, focused bootstrap/init tests (30), and full workspace suite (150 files, 1,829 tests) pass.
- The property-management repo uses `@gate-forge/cli: file:../gateforge/packages/cli`; discovery succeeds (1,201 entries), while its existing `check` remains red with 518 blocking summary items.

## COMPLETION REFERENCES
- Plan: `docs/plans/immediate/20260919_1544_endpoint_behavior_and_trust_megaplan.md` §§21–22
- Verification: `npm run build`; `npm run typecheck`; `npx vitest run packages/cli/test/init.test.ts packages/cli/test/podman-bootstrap.test.ts packages/cli/test/args.test.ts`; `npm test -- --run`
- Consumer verification: `npx gateforge --version`; `npx gateforge tests discover --json`; `npx gateforge check --format json`
- Host acceptance: Podman 6.1.2 installed through Gateforge; rootless info and managed doctor verification passed.

## ARCH UPGRADE CONSENT CORRECTION
- The first live `init --managed` retry used `pacman -Syu --needed podman` after a targeted 404 and upgraded 299 host packages (~4.7 GiB). This was broader than necessary and was not prompted by Gateforge.
- The implementation now tries `pacman -S --needed podman` first and asks the owner before any `pacman -Syu --needed podman` fallback. Non-interactive fallback is refused.
- Added async confirmation tests for targeted-first ordering, approval, and refusal.
- Live verification completed: Podman 6.1.2 installed; `podman info` reported `true`; property `.gateforge.yml` is `mode: managed`, `strictE2E: true`; `enforcement doctor --json` exited 0.

## LIVE MANAGED-CONTAINER PROOF
- In-chat task subagent exercised the existing `resolveIsolation()` path against `/home/ukd/Work/aetherios-property-management`.
- Rootless Podman 6.1.2 is operational, but no local images or controller existed. The exact managed image build failed closed because `FEDORA_BASE_DIGEST` is unset and produced `quay.io/fedora/fedora@`.
- Direct isolation launch failed closed before Podman because `GATEFORGE_MANAGED_CONTROLLER_IMAGE` was not an owner-provisioned immutable sha256 digest.
- No container, image, private network, or source files were created/changed by the proof attempt; cleanup was confirmed.
- Remaining owner inputs: approved Fedora base digest, immutable controller image digest, trusted `/engine` bundle/service account/network provisioning, verifier key, and approved policy digest.

## MANAGED CONTROLLER PROOF CORRECTIONS
- Approved Fedora amd64 base digest: `sha256:a43233b829403f8f21d0b0f3e20836ba3c386c95cfa572e9e240009e6a75bf8c`.
- Fedora 44 rejected the original `podman-tools` package; the Containerfile now installs `nodejs`, `git`, and `git-lfs`.
- The Containerfile now creates `gateforge-runner` UID 10001 and invokes `/engine/bin/gateforge.js`, matching the npm bundle.
- Rootless Podman resolved `--network private` to `pasta`, so the heartbeat-only controller now uses `--network none`; shared app/worker networking remains an owner-provisioned internal-network concern.
- Live immutable-image proof passed with `localhost/gateforge-managed-controller@sha256:bc70bb9a26cddaf2a8d10aade6a6f7815e4714af58bf7e8665537fa4f4727782`: Gateforge launched, authoritative inspect matched the exact image/user/network/mount contract, and the controller emitted a healthy heartbeat. Cleanup removed the controller.
- Proof required staged paths outside `/home` and rootless subordinate-ID ownership for writable app state. `init --managed` still verifies Podman only; automatic engine/image/state provisioning and non-Linux backends remain open.
- Managed initialization now rejects non-Linux platforms before probing or
  installing Podman. Current support is Linux + rootless Podman; Windows/macOS
  need dedicated backends rather than assumed Docker Desktop/Podman Machine/WSL
  equivalence.

## VERIFICATION AFTER MANAGED-RUNTIME CORRECTIONS
- Targeted managed-runtime tests: 2 files / 23 tests passed.
- Full Gateforge suite: 150 files / 1,829 tests passed.
- `npm run typecheck`: all workspaces passed.
- `npm run build`: all workspaces passed.
- `git diff --check`: passed.

## RELEASE CANDIDATE 0.5.0
- All public workspaces moved from `0.4.1` to `0.5.0`; internal dependency
  ranges and `package-lock.json` were synchronized.
- Release verification passed after relinking workspace dependencies:
  150 test files / 1,829 tests, all workspace typechecks, all workspace builds,
  `git diff --check`, and CLI `npm pack --dry-run`.

## RELEASE PUBLICATION
- Release commit `2511926` was pushed to `github/main`.
- Annotated tag `v0.5.0` was created and pushed.
- `.github/workflows/publish.yml` publishes workspace packages from `v*`
  tags through npm trusted publishing (OIDC); no local publish was run.
- Dry-run artifact: `gate-forge-cli-0.5.0.tgz`.
