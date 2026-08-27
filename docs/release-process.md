# Release Candidate Process

`.github/workflows/release-candidate.yml` assembles short-lived, exact-commit release candidates.
It does not publish a GitHub Release, create a source archive, or compile a plugin from the
release runner's checkout.

## Closed Native Variant Set

Release candidates are a closed set of three Windows editor binaries. They are not one universal
plugin archive:

| Variant | Exact editor identity | BuildId | Package artifact | Build-environment artifact |
| --- | --- | --- | --- | --- |
| `UE54-Win64` | UE 5.4.4, CL 35576357, compatible CL 33043543 | `33043543` | `UnrealEditorWebUI-Package-UE54-Win64` | `UnrealEditorWebUI-BuildEnvironment-UE54-Win64` |
| `UE55-Win64` | UE 5.5.4, CL 40574608, compatible CL 37670630 | `37670630` | `UnrealEditorWebUI-Package-UE55-Win64` | `UnrealEditorWebUI-BuildEnvironment-UE55-Win64` |
| `UE58-Win64` | UE 5.8.0, CL 55116800, compatible CL 0 | `55116800` | `UnrealEditorWebUI-Package-UE58-Win64` | `UnrealEditorWebUI-BuildEnvironment-UE58-Win64` |

Install only the archive matching the project's UE minor version. The resolver, package module
manifest, plugin descriptor `EngineVersion`, and BuildId checks deliberately reject cross-variant
substitution. A successful UE 5.4 job cannot stand in for UE 5.5 or UE 5.8.

The checked-in source of truth is `scripts/ue-release-variants.json`. Its decoder locks the exact
three-entry order, engine/runtime/toolchain identities, runner labels, job names, and artifact
names. The hosted configuration job emits the protected workflow matrix from that registry so the
workflow does not maintain a second hand-written matrix.

## Trust And Commit Binding

Before extracting any package, the candidate workflow fails closed unless all of these conditions
hold:

- The requested release tag exists as `refs/tags/<tag>` and resolves to the checked-out `HEAD`.
- The selected workflow path is exactly `.github/workflows/ue-ci.yml`, its event is a trusted
  `main` push or approved manual dispatch from `main`, and it completed successfully for the exact
  40-character release commit.
- The selected run attempt exposes exactly the three required jobs: `UE 5.4 BuildPlugin and
  automation`, `UE 5.5 BuildPlugin and automation`, and `UE 5.8 BuildPlugin and automation`.
- Each job is completed/successful, belongs to that run and commit, has a safe unique id and named
  runner, and has only its expected closed engine label in addition to `self-hosted`, `windows`,
  and `gui`.
- The run contains exactly three non-empty, non-expired package artifacts and exactly three
  non-empty, non-expired build-environment artifacts, with the names in the table above.
- Every artifact has a unique positive id, an immutable API-provided SHA-256 digest, and metadata
  binding it to the selected run and commit.
- All six raw artifact archives are downloaded into a fresh directory and verified by id and
  digest. A partial set is removed and never promoted.
- The shared safe extractor rejects encrypted entries, links, special files, unsafe or ambiguous
  paths, case/Unicode collisions, prefix conflicts, unsupported compression, oversized archives,
  zip bombs, CRC mismatches, and non-fresh destinations.
- All three `BuildEnvironment.json` documents are safely extracted and closed-schema verified
  before any package archive is extracted.
- Each canonical environment document binds its release variant, exact engine identity and
  BuildId, actual UBT-selected compiler/toolchain and Windows SDK, runtime version identity,
  repository, commit, run id/attempt, job, and package artifact id/name/digest.
- After package extraction, the descriptor has `Installed: true`, an exact variant
  `EngineVersion` (`5.4.0`, `5.5.0`, or `5.8.0`), and a `VersionName` matching the tag.
- Each package has exactly one Win64 module manifest, exactly one `UnrealEditorWebUI` mapping to
  `UnrealEditor-UnrealEditorWebUI.dll`, the variant's exact BuildId, and a non-empty DLL.
- `SourceManifest.json` names the exact release commit and contains the generated
  `Web/dist/index.html`; the packaged MIT `LICENSE` matches the checked-out commit.

The packaging helpers materialize tracked inputs from the selected commit's Git objects, validate
the exact lockfile before `npm ci`, build the frontend in an isolated staging tree, and overlay
only the newly generated `Web/dist`. Dirty or untracked working-tree content is not a package
input. The output directory is fresh and never overwritten.

## Candidate Outputs

One short-lived `release-candidate-v...` Actions artifact contains:

- `UnrealEditorWebUI-v...-UE54-Win64.zip` and its `.sha256` sidecar.
- `UnrealEditorWebUI-v...-UE55-Win64.zip` and its `.sha256` sidecar.
- `UnrealEditorWebUI-v...-UE58-Win64.zip` and its `.sha256` sidecar.
- `build-environment-UE54-Win64.json`, `build-environment-UE55-Win64.json`, and
  `build-environment-UE58-Win64.json`.
- A CycloneDX frontend npm build-dependency SBOM and normalized locked dependency inventory from
  the exact `frontend/package-lock.json`. This metadata does not cover the plugin C++ source,
  precompiled DLLs, Unreal Engine, CEF, Python runtime, or the complete ZIP contents, so it must not
  be presented as a complete UE plugin/runtime SBOM.
- Schema 3 `provenance.json`, binding the three job/artifact pairs, canonical build environments,
  and final release archive filenames and SHA-256 hashes to one commit and run attempt.
- GitHub/Sigstore SLSA build provenance signed for exactly the three final native ZIP subjects. The
  attestation is stored by GitHub rather than copied into the candidate artifact, and candidate
  upload fails if signing fails.
- Each native ZIP contains the exact repository `LICENSE`; no separate top-level license file is
  uploaded by the candidate bundle.

The schema 3 `provenance.json` is project-defined evidence joining the upstream UE build run to
release assembly. The GitHub attestation independently signs each final ZIP digest and identifies
the assembly workflow. Neither substitutes for the clean-consumer tests below, and the signed
provenance does not by itself prove a complete dependency inventory or the correctness of the
upstream UE compilation.

The candidate artifact is review material, not a published release. Publishing or copying these
files to a permanent distribution channel is a separate authorized action.

## Validation Required Before Candidate Assembly

For the unchanged tagged commit:

1. Run `UE CI` on `main` with the protected self-hosted validation enabled.
2. Wait for all three serialized native jobs to pass. Each exact variant performs BuildPlugin,
   native Bridge/Settings automation, packaged Python smokes, three representative Tool Packs
   (two v1 fixtures and one v2 example), and the real GUI CEF task/event/DOM test.
3. Wait for the second three-runner wave to pass the three exact Rez external-path activation jobs.
4. Review the three bounded allowlisted runner diagnostic artifacts. Raw UE/UAT logs stay local;
   diagnostic artifacts are never release inputs.
5. Dispatch the candidate workflow with the existing tag and exact trusted UE run id, or let the
   tag push resolve an eligible run automatically.
6. Verify the candidate ZIP hashes, review `provenance.json`, and verify each ZIP's GitHub
   attestation before any separate publication.

For example, after downloading the candidate created by the tag-push run and substituting its
40-character tag commit:

```powershell
gh attestation verify .\UnrealEditorWebUI-v0.3.0-UE55-Win64.zip --repo zhuoxyang/unreal-editor-webui --signer-workflow zhuoxyang/unreal-editor-webui/.github/workflows/release-candidate.yml --source-ref refs/tags/v0.3.0 --source-digest <tag-commit-sha>
```

Repeat the command for `UE54-Win64` and `UE58-Win64`. This verifies signed subject identity and
workflow provenance; the adjacent `.sha256` file remains the simple offline byte-integrity check.
For a manually dispatched review candidate, replace `--source-ref` with the exact ref that triggered
that workflow run. Only the tag-push candidate proceeds through the immutable publication sequence.

The frontend is compiled for the oldest maintained embedded Chromium runtime (`chrome90`) so the
same source bundle can load in UE 5.4/5.5 CEF 90 and UE 5.8 CEF 128. Runtime evidence records and
checks reported Python/CEF versions; it does not claim byte-for-byte Python or CEF DLL identity.

## Binary-Only And Clean-Consumer Boundary

Each protected job copies its BuildPlugin output into a fresh temporary host, removes the plugin's
`Source` and `Intermediate` directories, verifies the remaining descriptor/frontend/Python/module
binary, and rejects logs that show UnrealBuildTool or plugin recompilation. This is a useful
binary-only simulation on the build host.

It is not proof of the external-consumer baseline because the same host still has its build tools.
That baseline is intentionally narrower than a generic "no compiler" claim: the read-only mapped UE
installation contains its own UBT, bundled .NET, and embedded Python. Three independent Windows
Sandbox guests must instead prove the six closed external-system results (Node.js and npm command
resolution/PATH, usable system-Python command and external runtime, Visual Studio installation,
MSVC compiler, and Windows SDK development files all absent), plus the real off-diagonal rejections
and no compile/rebuild or runtime-install markers in every matching launch. See
[Clean-Host Windows Sandbox Acceptance](clean-host-acceptance.md).
Runner provisioning and real exact-version executions are also external infrastructure work; no
commit may be described as release-validated until all three protected GUI jobs have actually
passed for that exact commit.

## Immutable Publication

Only after the exact final `main` commit passes the protected UE matrix may a maintainer create
`v0.3.0`. Never move, delete, or reuse a release tag after candidate generation; a required code or
binary change advances to a new patch version. Publication then follows this closed sequence:

1. Push the tag for the already validated commit and let the candidate workflow consume the exact
   trusted UE run.
2. Download the short-lived candidate bundle and verify all three SHA-256 sidecars, project
   provenance, build environments, and signed attestations.
3. Complete the candidate-mode
   [clean-host Windows Sandbox gate](clean-host-acceptance.md). Its three independent guests must
   meet the six-field external-consumer baseline above without installing any guest dependency,
   and its finalized evidence must contain exactly three matching successes plus six off-diagonal
   prelaunch rejections. Preparation must derive the harness and fixture-pack inputs from a safely
   extracted `git archive` of the exact release commit. Its private manifest must bind the copied
   validator/variant module, harness, plans, and Sandbox configurations, and each guest must finish
   with a result hash bound by its last-written completion sentinel. Enabling Windows Sandbox and
   restarting the host are explicit manual prerequisites, not harness actions. The checked-in
   harness has not yet been executed in real Sandbox guests, so publication remains blocked.
4. Publish only the three ZIPs, their three `.sha256` files, the three build-environment documents,
   the frontend npm dependency metadata, and schema 3 project provenance as the immutable GitHub
   Release assets.
5. Release notes must state the exact UE 5.4.4/5.5.4/5.8.0 compatibility matrix, per-version ZIP
   selection, Tool Pack trust allowlisting and restart requirement, direct project-plugin setup,
   and the optional Rez external-plugin-root workflow.
6. Re-download every public asset, compare its byte hash with the reviewed candidate, re-run the
   three attestation checks, repeat the clean-host gate with `SourceKind = "published"`, and confirm
   the tag, descriptor `VersionName`, provenance commit, public bytes, and finalized replay evidence
   all agree. Candidate evidence must not be relabeled as the public replay.

## GUI Evidence Boundary

The commandlet smokes do not create an interactive CEF window. The separate
`UnrealEditorWebUI.Browser.CEFBindingAndTaskEvent` test launches `UnrealEditor.exe` in an
interactive non-Session-0 desktop. It observes the packaged React UI, delayed UObject binding,
closed product health/report DOM, privacy canaries, `system.ping`, task events, detail, and TaskCard
rendering. Native/headless or hosted checks alone must not be called browser end-to-end coverage.

UE 5.8 launches use the engine's early restrictive Python mode. UE 5.4 and UE 5.5 cannot provide
the same isolation guarantee, so their preflight rejects a user-global
`Documents/UnrealEngine/Python/init_unreal.py` before BuildPlugin and requires a dedicated clean
Windows profile.
