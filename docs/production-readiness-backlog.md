# Production Readiness Backlog

This document contains the GitHub issue drafts produced by the production-readiness review. Each issue is intentionally scoped so it can be implemented and verified independently. Acceptance criteria should only be marked complete after the corresponding automated and Unreal Editor validation has completed.

## P0 - Security / CI

### Isolate self-hosted UE validation and restore a green trusted path

Public pull-request code must never execute directly on a persistent, licensed Unreal Engine runner. The trusted UE job also needs an explicit operating model because a queued or offline runner provides no merge or release signal.

Acceptance criteria:

- Pull requests run only GitHub-hosted source, frontend, and Python checks.
- The self-hosted UE job runs only for `main` or an explicitly approved manual dispatch.
- The trusted job is protected by a GitHub environment and least-privilege workflow permissions.
- Checkout credentials are not persisted and logs are retained on failure.
- The package artifact is published only after the complete trusted job succeeds.
- Runner setup, offline behavior, and required-check policy are documented.

## P1 - Bridge Security

### Scope bridge origins, task sessions, and privileged approvals

Treating every loopback address as equally trusted allows a different local service to inherit the bound UObject bridge after navigation. Task identifiers and privileged approvals must also be limited to the active top-level document.

Acceptance criteria:

- Runtime navigation is restricted to the exact configured scheme, host, and port, or to packaged plugin files.
- Every top-level document load creates a new opaque bridge session.
- Task read, cancel, remove, and event operations are limited to the task's creating session.
- Real write and destructive requests require payload-specific, single-use approval.
- Dry-run approval cannot authorize a later real write.
- The native prompt includes the command and a bounded payload summary.

## P1 - Runtime Integrity

### Execute cooperative handlers and make batch writes truthful

`editor_tick` tasks must execute registered Python work rather than return synthetic C++ progress. Batch write commands must not report a failed item as unchanged after a rename succeeded but its save failed, and an all-failed batch must fail the command envelope.

Acceptance criteria:

- Cooperative commands use a registry-owned start/step/cleanup protocol.
- Progress, logs, terminal results, cancellation, and timeouts come from the real handler lifecycle.
- Direct synchronous execution of an `editor_tick` command returns `task_required`.
- Batch results distinguish unchanged failures, saved changes, and changed-but-unsaved assets.
- An all-failed batch returns an error envelope and task status `failed`.
- Unit tests cover success, partial failure, total failure, cancellation, timeout, and cleanup.

## P1 - Performance / Resource Bounds

### Bound bridge payloads and make task reconciliation summary-only

Task reconciliation currently risks repeatedly serializing retained request payloads, log arrays, and full command results. Unbounded JSON can stall the embedded browser and retain excessive memory in both C++ and Python.

Acceptance criteria:

- Bridge requests, settings, task responses, log lines, JSON depth, and JSON node counts have documented limits.
- Oversized input and output return stable structured error codes.
- `listtasks()` returns lifecycle summaries without payloads, logs, or `responseJson`.
- Full task detail is loaded only through `gettask()` when the UI requests it.
- Task retention remains bounded across document sessions.
- Tests cover boundary and over-limit cases.

## P1 - Frontend Correctness

### Add invocation state, runtime decoders, and strict input handling

Required numeric fields must not turn an empty string into zero. Commands also need a visible invocation lifecycle so duplicate writes, stale responses, and stale successful output cannot be mistaken for the latest run.

Acceptance criteria:

- Empty required numeric fields fail before a bridge call.
- Numeric minimum, maximum, and exclusive bounds are enforced consistently.
- Each command/mode has an `idle`, `pending`, `success`, or `error` invocation state.
- Duplicate submission is disabled while pending and late responses cannot overwrite newer state.
- Failure is shown beside the command and previous output is marked stale or cleared.
- Command, settings, task, and mutation result bodies are runtime-decoded.
- Initial-load failures provide an explicit retry action.

## P2 - Frontend Security / Scalability

### Scope persisted state per project and harden exports

Fixed local-storage keys mix payload history and preferences between Unreal projects using the same browser profile. CSV cells beginning with spreadsheet formula characters also require neutralization before export.

Acceptance criteria:

- The native bridge exposes a stable, non-sensitive project storage namespace.
- Recent executions and tool preferences are stored under project-scoped keys.
- Legacy global data is quarantined instead of being attributed to an arbitrary project; the project-scoped runtime never reads or writes it.
- Users can clear project-local history and preferences.
- CSV export neutralizes `=`, `+`, `-`, `@`, tab, and carriage-return formula prefixes.
- Storage migration and malicious-cell cases are covered by tests.

## P2 - Release Engineering

### Add packaged E2E, supported UE matrix, and verifiable releases

Source-only hosted checks are not proof that the packaged plugin loads and completes a browser-to-UObject-to-Python command. Release claims and artifacts must be tied to a successful trusted Unreal run for the exact commit.

Acceptance criteria:

- Documentation distinguishes the tested UE version from unverified versions.
- A trusted test covers the packaged frontend, bound UObject bridge, Python registry, and at least one read-only command.
- Release artifacts are produced from the same commit that passed trusted UE validation.
- Archives include checksums and machine-readable provenance or an SBOM.
- GitHub Actions dependencies and runner downloads are pinned and updateable.
- Source-install instructions build `Web/dist` before opening the plugin.
- A repository license is selected explicitly by the owner and included in release packages.
