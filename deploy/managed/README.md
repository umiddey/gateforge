# gateforge managed/ — rootless Podman reference deployment

Plan 2026-09-19 Phase 10. This directory holds the **reference assets**
for the managed-authoritative deployment. These files are the contract;
actual enforcement requires the OWNER-PROVISIONED host (disposable
project, rootless Podman, dedicated service accounts, browser-capable
isolated runner). Nothing here provisions credentials or grants.

## Layout

| File | Purpose |
| --- | --- |
| `controller.containerfile` | Pinned engine image build for the controller/authority container. |
| `runtime-profile.md` | The four-role runtime (app / worker / controller+authority / browser) with mount, user, and network rules. |
| `authority.env.template` | Authority environment template (`GATEFORGE_AUTHORITY_BOUNDARY=managed-authoritative`, verifier key, approved policy digest). Owner fills; never commit filled values. |

## Current support boundary

The managed backend currently supports **Linux with rootless Podman** only.
`gateforge init --managed` refuses other operating systems instead of
pretending Docker Desktop, Podman Machine, or WSL have identical mount and
network semantics. A future Windows/macOS backend must define and verify its
own runtime contract before it can be accepted.

## Hard rules (validated by `packages/cli/src/isolation.ts`)

1. Rootless only: the controller runs as a dedicated non-root user
   (`gateforge-runner`). Host home directories and host Git directories
   are never mounted.
2. Mounts: engine bundle read-only at `/engine`; candidate checkout
   read-only at `/candidate`; disposable app state writable at
   `/app-state`. Nothing else is mounted.
3. Network: the current heartbeat-only controller uses `none`; it never uses
   Podman's rootless `private` token (which resolves to `pasta`), host
   networking, or a container socket. Any future app/worker shared network
   must be an owner-provisioned internal network with its own inspection rule.
4. The authority sets `GATEFORGE_AUTHORITY_BOUNDARY=managed-authoritative`
   in its own environment; the broker then rejects every receipt whose
   `executionBoundaryDigest` says `local-unisolated`.

## What this directory does NOT do

- It does not create hosts, users, tokens, or protected branch rules —
  the owner does.
- It does not make a local run "protected": a developer machine without
  the managed runtime reports `local-unisolated` and is honestly
  rejected by a protected authority.
- It does not substitute for the Phase 10 host acceptance records
  (job/check URLs, candidate/base/tree ids, observed rejections).
