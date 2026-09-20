# Managed runtime profile (plan 2026-09-19 §4.10, Phase 10)

Four roles, four boundaries. Each row states what the role may execute,
who signs/approves, and what state it can write.

| Role | Executes candidate code? | Signs/approves? | Writable state |
| --- | --- | --- | --- |
| Coding agent | yes | no | its working tree only |
| Test worker | yes | no | per-run test output/scratch |
| Candidate app | yes | no | disposable app state under declared credentials |
| Engine browser/witness/controller | approved engine code only | evidence authority only | private run state; controlled fixture service |
| Approval authority/broker | no candidate code | yes, exact approved candidate | authoritative Git refs and private policy/keys |

## Controller container (rootless Podman)

- Image: `deploy/managed/controller.containerfile` (pinned Fedora base +
  Node; engine installed only from the approved bundle).
- User: dedicated `gateforge-runner` (never root, never the agent's UID).
- Mounts (exactly three):
  - `/var/gateforge/engine` → `/engine` (**read-only**) — approved
    engine/policy bundle, outside every candidate path;
  - `/var/gateforge/candidate` → `/candidate` (**read-only**) — the
    frozen candidate checkout;
  - `/var/gateforge/app-state` → `/app-state` (writable) — disposable
    app state under declared credentials.
- Network: the current heartbeat-only controller uses `none`; it never uses
  Podman's rootless `private` token (which resolves to `pasta`), host
  networking, or a container socket. A future shared app/worker network must
  be an owner-provisioned internal network with separate inspection rules.
- Hard denials: no host PID namespace, no ptrace, no writable engine
  directory, no leaked inherited descriptors, no host home, no host Git
  directory, no broad host filesystem, no container socket.

## Worker and app containers

- The worker reaches ONLY the constrained witness case API
  (`/behavior/execute`, `/behavior/principal`); app mutation/database
  ports are unreachable from the worker network namespace.
- The app has only its test-namespace data credentials; the observer
  has independently provisioned read-only access; the worker has
  neither.
- Package install lifecycle hooks are candidate execution and receive
  no authority secrets.

## Boundary records and acceptance

- The controller returns an `IsolationRecord`
  (`packages/cli/src/isolation.ts`); its digest is sealed into every
  receipt as `executionBoundaryDigest`.
- `local-unisolated` is the honest developer-machine record; a
  protected authority (`GATEFORGE_AUTHORITY_BOUNDARY=managed-authoritative`)
  rejects it for managed acceptance.
- Owner-provisioned approval bundle updates are separate administrative
  actions: no `tests mark`, no agent waiver, no changed config, and no
  candidate CLI flag can approve a new trusted bundle.
