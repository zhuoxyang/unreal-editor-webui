# Release Candidate Process

`.github/workflows/release-candidate.yml` assembles short-lived release candidates. It does not publish a GitHub Release and does not manufacture a plugin from an unvalidated source checkout.

## Trust And Commit Binding

Before downloading anything, the workflow resolves the checked-out commit and verifies a `UE CI` workflow run through the GitHub API. The candidate fails closed unless all of these statements are true:

- The workflow path is exactly `.github/workflows/ue-ci.yml`.
- The workflow completed successfully for the exact 40-character commit being released.
- The event was a push to `main` or an explicitly dispatched trusted run.
- The run attempt is a safe positive integer, and the attempt-specific jobs API reports exactly one successful `UE 5.8 BuildPlugin and automation` job for that attempt.
- That job was assigned to a named runner carrying `self-hosted`, `windows`, `gui`, and `ue-5.8` labels.
- The run contains exactly one non-empty, non-expired `UnrealEditorWebUI-Package-UE58` artifact with an immutable SHA-256 digest.
- The same run contains exactly one non-empty, non-expired `UnrealEditorWebUI-BuildEnvironment-UE58` artifact with an immutable SHA-256 digest.
- Both artifact metadata records remain bound to that workflow run and commit.
- Both raw artifact ZIPs are downloaded by id into private sibling staging paths and hash to their exact API-provided SHA-256 digests before either final archive is published or extracted. The two verified files are then published with no-overwrite operations; any failure removes every staging file and final file created by that invocation. Release consumption has no package-only compatibility mode.
- A shared safe extractor preflights the complete ZIP before writing, accepts only stored or deflated data, rejects encrypted entries, unsafe or ambiguous paths, Unicode/case collisions, file/directory prefix conflicts, links and special files, and enforces profile-specific archive, entry, compressed, expanded-size, and compression-ratio limits. Extraction streams into a fresh private sibling directory and publishes it only after every entry's actual byte count and CRC are verified. The package profile allows at most 20,000 entries, a 128 MiB archive, 120 MiB of member-compressed data, a 1 GiB entry, 2 GiB expanded in total, and a 200:1 ratio, leaving substantial headroom over the current package and UE PDB.
- The build-environment profile permits exactly one non-empty regular root `BuildEnvironment.json`, a 256 KiB archive, 128 KiB of member-compressed data, 64 KiB expanded, and a 100:1 ratio. Its closed-schema canonical verification completes before the separately bounded package archive is extracted.
- The build-environment verifier checks its closed schema and binds its repository, commit, workflow run id and attempt, job key, and package artifact id/name/digest to the independently resolved GitHub metadata. It then writes the only canonical copy used by provenance.
- The source and packaged descriptors both have a `VersionName` matching the candidate tag.
- After safe extraction, the package contains `UnrealEditorWebUI.uplugin`, `Web/dist/index.html`, the exact commit's MIT `LICENSE`, and `SourceManifest.json`; the manifest names the same release commit and classifies the frontend entry point as generated. Symbolic links, special files, path escapes, ambiguous names, and extraction bombs are rejected before package files are read.

A tag push searches for an eligible UE run for that exact commit. A manual run requires the operator to select the release commit and provide the exact trusted UE workflow run id. A run id for a different commit, an invalid attempt, a skipped UE job, either missing/partial/expired evidence artifact, or a hosted-only validation cannot be promoted.

The UE packaging helpers never copy plugin inputs from the live working tree. They materialize regular tracked files directly from the selected commit's Git blobs, rebuild the frontend from that commit in an isolated tree, then overlay only the fresh `Web/dist`. The deterministic pre-UBT manifest records every staged path, its SHA-256 and size, and either its Git mode/blob or generated provenance. On Windows, `BuildPlugin` uses a short random system-temp directory on the output volume so UnrealBuildTool action paths remain below its 260-character limit, then publishes it with a same-volume no-overwrite directory move. On Unix, it writes to a private sibling, atomically reserves the final directory name, populates it, and moves `SourceManifest.json` last as the completion marker. Neither path overwrites a stale or concurrently created final path. Dirty tracked bytes, untracked files, tracked build output, symlinks, gitlinks, and stale package directories fail closed.

Manually dispatched UE 5.3 compatibility runs are intentionally ineligible: they use the job name `UE 5.3 BuildPlugin and automation (compatibility only)`, the runner label `ue-5.3`, and the artifact name `UnrealEditorWebUI-Package-UE53`. The release verifier accepts only the corresponding UE 5.8 GUI job and labels together with the `UnrealEditorWebUI-Package-UE58` and `UnrealEditorWebUI-BuildEnvironment-UE58` evidence pair.

## Candidate Outputs

The workflow uploads one short-lived `release-candidate-v...` Actions artifact containing:

- `UnrealEditorWebUI-v...-UE58.zip`, created only from the trusted UE package artifact.
- A SHA-256 sidecar for the ZIP.
- A CycloneDX npm SBOM generated from the exact commit's package lock.
- A normalized locked npm dependency inventory including resolved sources and integrity values.
- Canonical `build-environment.json`, containing the verified UE patch/build identity, actual UBT-selected compiler/toolchain and Windows SDK, architecture, and Node/npm versions without machine-specific paths or secrets.
- Schema 2 `provenance.json`, recording the release commit, trusted UE run id/attempt/job, package artifact identity, build-environment artifact identity, the complete canonical build-environment object, the canonical file's SHA-256, and the validation claim. The embedded object is generated from and checked for deep equality with `build-environment.json`.

Schema 2 preserves every schema 1 key with its original meaning. In particular, `ueValidation.artifactId`, `artifactName`, and `artifactDigest` still identify the packaged plugin, while `ueValidation.buildEnvironmentArtifact.artifactId`, `artifactName`, and `artifactDigest` identify the separate evidence artifact. Consumers that strictly accept only schema 1 must upgrade before reading new candidates. New candidates fail closed and do not emit a downgraded schema 1 provenance file.

The source checkout is used for version checks and dependency metadata only. It is never substituted for a missing UE package artifact.

## Triggering A Candidate

Preferred tag flow:

1. Update `UnrealEditorWebUI.uplugin` so `VersionName` matches the intended semantic version and the positive integer `Version` is greater than every earlier release. `scripts/validate-plugin-version.mjs` checks canonical semantic versions, tag/descriptor agreement, and monotonic metadata across all reachable `v*` tags. Then commit every final source and documentation change.
2. Run the protected UE 5.8 `UE CI` workflow for that unchanged commit and wait for the complete UE job, including GUI CEF automation, to succeed.
3. Create and push the matching `v...` tag pointing to that exact validated commit.
4. Review the `Release Candidate` summary, provenance, SBOM, archive contents, and SHA-256 before any external promotion.

For a manual rehearsal, select the exact reviewed ref in `Actions > Release Candidate > Run workflow`, enter its matching `v...` candidate tag, and supply the successful UE workflow run id.

## Packaged Bridge And GUI CEF Validation

`scripts/validate-packaged-bridge-smoke.py` runs in the temporary host project created from the BuildPlugin artifact and checks the packaged React entry point plus every referenced local asset. The native automation test `UnrealEditorWebUI.Bridge.PackagedRegistryPing` separately creates `UUnrealEditorWebUIBridge` in C++ and sends `system.ping` through the production bridge into the real packaged Python registry. Keeping this call in native automation avoids exporting production bridge methods as Blueprint/Python-callable APIs solely for testing.

The commandlet smoke does not create an interactive CEF window. The separate `UnrealEditorWebUI.Browser.CEFBindingAndTaskEvent` test runs through `UnrealEditor.exe` on the required interactive `gui` runner and verifies the packaged React page, delayed JavaScript binding, native health context, the rendered support-report allowlist and negative privacy canaries, `system.ping` task execution, native task event, DOM delivery, task detail, and rendered React task card. Release provenance requires both validation layers from the same exact-commit UE 5.8 job.

## Promotion Policy

The repository currently makes no automated GitHub Release and grants this workflow no `contents: write` permission. Promotion is a separate owner-approved action after reviewing the candidate and validation evidence. The owner selected the MIT License; packaging copies the exact repository `LICENSE`, and candidate assembly rejects a missing or mismatched copy.
