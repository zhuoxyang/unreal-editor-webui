# Clean-Host Windows Sandbox Acceptance

This procedure is the reproducible clean-consumer gate for the three `v0.3.0` Windows native
archives. It validates already-built candidate or re-downloaded public bytes; it does not build the
core plugin, publish a release, enable Windows features, or install guest dependencies.

A checked-in harness, a prepared `.wsb` file, or a binary-only simulation on a build runner is not
clean-host evidence. The gate passes only when one fresh run produces the finalized
`public/clean-host-acceptance.json` and matching `.sha256` from exactly three successful guest
documents. The repository currently contains the harness and deterministic contract tests, but no
real Windows Sandbox execution has yet produced that release evidence.

## Human Prerequisites

An operator must complete these host actions before invoking the harness:

- Use a native x64/AMD64 Windows host and edition that supports Windows Sandbox. Arm64 Sandbox
  guests are intentionally rejected because the release archives and evidence schema are Win64/x64. Enable the **Windows Sandbox**
  optional feature manually with administrator authorization, restart Windows when prompted, and
  confirm that `Containers-DisposableClientVM` is `Enabled`. The harness never enables the feature
  or restarts the host.
- Install the licensed exact UE 5.4.4, UE 5.5.4, and UE 5.8.0 builds named in
  [Validation Status And Boundaries](validation.md). The harness verifies their full engine identity
  and BuildId before preparing a run; a different patch or installed build fails closed.
- Put the complete candidate bundle, or a fresh re-download of the public release assets, in one
  local directory. It must contain the three native ZIPs, their three `.sha256` sidecars, and the
  matching schema 3 `provenance.json` bound to one lowercase 40-character release commit.
- Use a clean Git checkout whose `HEAD` is that exact release commit. The controller rejects tracked
  changes and non-ignored untracked files, creates a closed source snapshot with `git archive` from
  the supplied commit, safely extracts it, and uses only that snapshot for the guest harness,
  validator/module copies, and prepackaged fixture Tool Packs. Working-tree and ignored files are
  not snapshot inputs.
- Create an existing local output-parent directory on a separate tree from the repository,
  candidate/public input, and all engine roots. Candidate, engine, output, and evidence paths must
  not traverse a symlink, junction, or other reparse point.
- Close every existing Windows Sandbox instance. The automated launch mode refuses to share an
  active Sandbox session.

The controller may use the clean repository checkout, Git, controller Node.js, and UE 5.8's
embedded Python to prepare inputs and finalize evidence. Those controller dependencies are not
mapped as external guest development tools. The harness installs nothing on either the controller
or the guests.

## Three Independent Guests

One run has exactly three disposable Windows Sandbox guests, launched one at a time:

1. one guest mapped to the exact UE 5.4.4 installation;
2. one new guest mapped to the exact UE 5.5.4 installation;
3. one new guest mapped to the exact UE 5.8.0 installation.

Never reuse a guest or launch two configurations concurrently. Each `.wsb` configuration disables
networking and maps only these host locations:

| Guest path | Contents | Access |
| --- | --- | --- |
| `C:\UEWebUI\Input` | Verified candidate/public archives, prepackaged Tool Packs, closed plans, and guest harness | Read-only |
| `C:\UEWebUI\Engine` | The one exact UE installation assigned to that guest | Read-only |
| `C:\UEWebUI\Evidence` | A fresh, variant-specific evidence directory | Writable |

`CandidateRoot` itself is not exposed to a guest. Prepare copies only the verified closed inputs
into the fresh run tree, and that prepared candidate/public input is the read-only mapping above.
No repository checkout, general host directory, or external development-tool directory is mapped.

The guest records exactly six external-consumer baseline booleans:

1. `nodeCommandAbsent`: no `node` command resolves through guest command resolution/PATH;
2. `npmCommandAbsent`: no `npm` command resolves through guest command resolution/PATH;
3. `systemPythonRuntimeAbsent`: no usable system-Python command resolves and no external system
   Python runtime is present;
4. `visualStudioInstallationAbsent`: no Visual Studio installation is found through standard
   install roots, instance metadata, registry state, commands, or developer environment variables;
5. `msvcCompilerAbsent`: no MSVC compiler command or payload is found through those bounded roots,
   legacy Build Tools roots, or developer environment variables; and
6. `windowsSdkDevelopmentFilesAbsent`: no Windows SDK development files are found through Windows
   Kits registry roots, standard Program Files roots, or SDK environment variables.

The fixed read-only UE mapping itself includes UnrealBuildTool, its bundled .NET runtime, and UE's
embedded Python. Their presence is required engine payload and is deliberately excluded from the
six external-system claims, so this gate must not be described as a generic "no compiler" or "no
build tool" machine. The embedded Python is used for bounded safe extraction and packaged runtime
checks; matching editor logs must still contain no compile/rebuild or runtime-install markers.
Do not install Node.js, Visual Studio, MSVC/Build Tools, a Windows SDK, VC redistributables, system
Python, Unreal prerequisites, or any other runtime/package in a guest. The Tool Pack ZIPs are built
on the controller before launch and consumed as immutable guest inputs.

## Prepare-Only Mode

Run the controller script from the repository root. `OutputParent` must already exist, and every
path supplied to the script must be an absolute local path.

```powershell
$CleanHostArgs = @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", ".\scripts\invoke-clean-host-acceptance.ps1",
    "-CandidateRoot", "D:\uewebui-candidate-v0.3.0",
    "-SourceKind", "candidate",
    "-ReleaseCommit", "<lowercase-40-character-tag-commit>",
    "-UE54Root", "C:\Program Files\Epic Games\UE_5.4",
    "-UE55Root", "C:\Program Files\Epic Games\UE_5.5",
    "-UE58Root", "C:\Program Files\Epic Games\UE_5.8",
    "-OutputParent", "D:\uewebui-clean-host-runs"
)

$PreparedJson = & powershell.exe @CleanHostArgs
if ($LASTEXITCODE -ne 0) { throw "Clean-host preparation failed." }
$Prepared = $PreparedJson | ConvertFrom-Json
$Prepared
```

Without `-Launch` or `-Finalize`, the command verifies the release and engine identities, copies
the closed inputs, creates and safely extracts the exact-commit `git archive` snapshot, prepackages
the three representative Tool Packs from that snapshot, and emits a new run id, run root, and three
`.wsb` paths. A private `run-manifest.json` binds the run-root name and release identity to the
source-snapshot archive, copied controller host script, copied validator and variant registry/module,
mapped guest script and extractor, three plans, and three Sandbox configurations by SHA-256. It does
not start Windows Sandbox.

For an operator-controlled run, open `$Prepared.configurations.ue54`, wait for that guest to finish
and close, and confirm that its private `guest-binding.json` completion sentinel exists alongside
`guest-result.json` before opening `ue55`; repeat for `ue58`. Do not edit, replace, or reuse either
file. After all three guests have completed, use finalize-only mode below.

## Automated Launch Mode

To prepare a different fresh run, launch its three guests sequentially, and finalize it in one
controller invocation, add `-Launch`:

```powershell
$FinalizedJson = & powershell.exe @CleanHostArgs "-Launch"
if ($LASTEXITCODE -ne 0) { throw "Clean-host launch failed." }
$Finalized = $FinalizedJson | ConvertFrom-Json
$Finalized
```

`-Launch` does not resume the run returned by an earlier prepare-only invocation. It creates a new
run, verifies that Windows Sandbox is enabled and no other Sandbox instance is active, starts one
guest per variant, waits for its binding sentinel and process exit before starting the next, and
automatically finalizes the three results. A timeout, guest failure document, or Sandbox process
that does not close fails the invocation.

## Finalize-Only Mode

Finalize an operator-controlled prepared run after all three result/binding pairs exist:

```powershell
$FinalizeArgs = @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", ".\scripts\invoke-clean-host-acceptance.ps1",
    "-Finalize", "-RunRoot", $Prepared.runRoot
)
$FinalizedJson = & powershell.exe @FinalizeArgs
if ($LASTEXITCODE -ne 0) { throw "Clean-host evidence finalization failed." }
$Finalized = $FinalizedJson | ConvertFrom-Json
$Finalized
```

Finalize requires a controller Node.js version accepted by the repository `package.json` engines
and `.nvmrc` policy. It first revalidates the private manifest, exact clean
checkout, snapshot archive, copied controller validator/variant module and registry, mapped harness,
plans, configurations, and every per-guest binding/result digest. It then runs the copied and
manifest-bound validator to validate the three closed guest schemas and common release/input
binding, writes `public/clean-host-acceptance.json`, and writes its SHA-256 sidecar. It refuses
missing, duplicate, partial, malformed, oversized, reparse-mediated, unbound, or already-finalized
evidence. Start a fresh run instead of editing or replacing a failed result.

## Run Binding And Trust Boundary

Each guest verifies the plan-bound hashes of its mapped guest script and safe extractor before
testing UE. It writes `guest-result.json` first, hashes the completed bytes, and writes
`guest-binding.json` last. That binding is the completion sentinel and fixes the run id, variant,
plan digest, result digest, guest-script digest, and extractor digest. A result without its exact
last-written binding is incomplete and cannot be finalized.

The private manifest and per-guest bindings prevent accidental stale-file reuse, cross-run mixing,
and unnoticed replacement under the intended trusted local controller/operator model. The
controller operator and local administrators are part of the trusted computing base: an actively
malicious local administrator can alter the controller, Sandbox inputs, or evidence and forge new
matching files and hashes. This harness is reproducible release evidence, not an adversarial
attestation against a compromised host administrator.

## Closed 3 x 3 Matrix

Each guest receives all three native archives. A matching archive must launch and pass; both
non-matching archives must be rejected before Unreal Editor starts.

| Guest engine | `UE54-Win64` archive | `UE55-Win64` archive | `UE58-Win64` archive |
| --- | --- | --- | --- |
| exact UE 5.4.4 | success | prelaunch rejection | prelaunch rejection |
| exact UE 5.5.4 | prelaunch rejection | success | prelaunch rejection |
| exact UE 5.8.0 | prelaunch rejection | prelaunch rejection | success |

The finalized matrix therefore contains exactly three successes and six rejections. Every archive
must have its SHA-256, descriptor `Version`, `VersionName`, and `EngineVersion`, package shape,
single module mapping, module BuildId, and non-empty DLL validated before use. Each off-diagonal cell
must record `editorLaunched: false` and prove both the descriptor engine-version mismatch and module
BuildId mismatch; a rejection after editor launch is not acceptable.

Each diagonal cell must record a zero editor exit code, no compile/rebuild markers, no runtime
installation markers, successful packaged automation, and successful results for:

- `system.ping`;
- `system.toolPacks` with the three prepackaged representative packs;
- `fixture.asset.echo`;
- `fixture.level.echo`.

The matching editor's explicit `-abslog` is scanned for UnrealBuildTool, compile/rebuild,
incompatible/missing module, prerequisite, package-manager, and runtime-install activity. The
network and six-field consumer baseline checks run both before and after that editor process. Any
prohibited matching-log marker or post-run baseline change fails the cell; it must not be explained
away as a consumer success.

## Evidence And Privacy Boundary

The finalized JSON is a bounded, allowlisted evidence document. It contains only the release tag,
commit and source kind; guest OS/Sandbox identity; the closed six-field consumer baseline; exact engine identity;
archive and Tool Pack subjects and SHA-256 hashes; descriptor/module facts; command and automation
outcomes; the 3 x 3 matrix; and the matching editor log SHA-256 from each guest.

Raw UE, UAT, UBT, editor, Sandbox, and host logs are not evidence artifacts. The matching editor
log remains inside the disposable guest and is destroyed when that Sandbox shuts down; this harness
does not retain a troubleshooting log. Never commit or upload the run's `private` directory or its
`.wsb` files, source snapshot, manifest, guest results, or bindings, because private controller data
and mapped-folder configuration contain host paths. Public evidence must not contain usernames,
absolute host paths, control text, raw log bodies, credentials, tokens, secrets, or unexpected
fields. Only the finalized JSON and matching checksum are eligible for later release evidence
consumption after a privacy review.

The controller, guest, and validator chain fails closed on stale or reparse-mediated paths, a wrong engine/archive identity,
hash or provenance mismatch, an unexpected or missing field, duplicate JSON keys, partial guest or
matrix coverage, inconsistent guest inputs, a failed consumer-baseline fact, a nonzero launch, compile/install
markers, or privacy-prohibited text. Do not weaken the schema or manually sanitize a failed file;
correct the input or environment and create a new run.

## Candidate Gate And Public Replay

Before publication, run the complete procedure with `SourceKind = "candidate"` against the reviewed
candidate bundle. Publication remains blocked until its finalized evidence proves all three guests
and the complete 3 x 3 matrix. This harness does not authorize or perform publication.

After an authorized publication, re-download the public assets into a fresh directory, repeat the
hash and attestation checks in [Release Candidate Process](release-process.md), and run a new clean
host acceptance with `SourceKind = "published"`. The public replay must bind to the same immutable
tag commit and archive hashes. Candidate evidence cannot be relabeled or reused as published
evidence. `SourceKind` is an operator-supplied procedure label, not proof of download origin by
itself; the fresh public re-download, release-attestation verification, and immutable hash match are
the external provenance checks that make the published replay meaningful.
