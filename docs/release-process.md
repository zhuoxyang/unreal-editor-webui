# Release Candidate Process

`.github/workflows/release-candidate.yml` assembles short-lived release candidates. It does not publish a GitHub Release and does not manufacture a plugin from an unvalidated source checkout.

## Trust And Commit Binding

Before downloading anything, the workflow resolves the checked-out commit and verifies a `UE CI` workflow run through the GitHub API. The candidate fails closed unless all of these statements are true:

- The workflow path is exactly `.github/workflows/ue-ci.yml`.
- The workflow completed successfully for the exact 40-character commit being released.
- The event was a push to `main` or an explicitly dispatched trusted run.
- The job `UE 5.5 BuildPlugin and automation` exists exactly once and succeeded.
- That job was assigned to a named runner carrying `self-hosted`, `windows`, and `ue-5.5` labels.
- The run contains exactly one non-empty, non-expired `UnrealEditorWebUI-Package-UE55` artifact with an immutable SHA-256 digest.
- The artifact metadata remains bound to that workflow run and commit.
- The raw artifact ZIP downloaded by id hashes to that exact API-provided SHA-256 digest before any extraction occurs.
- The source and packaged descriptors both have a `VersionName` matching the candidate tag.
- The package contains `UnrealEditorWebUI.uplugin`, `Web/dist/index.html`, and the exact commit's MIT `LICENSE`, and contains no symbolic links.

A tag push searches for an eligible UE run for that exact commit. A manual run requires the operator to select the release commit and provide the exact trusted UE workflow run id. A run id for a different commit, a skipped UE job, a partial/expired artifact, or a hosted-only validation cannot be promoted.

Manually dispatched UE 5.3 compatibility runs are intentionally ineligible: they use the job name `UE 5.3 BuildPlugin and automation (compatibility only)`, the runner label `ue-5.3`, and the artifact name `UnrealEditorWebUI-Package-UE53`. The release verifier accepts only the corresponding UE 5.5 job, label, and `UE55` artifact.

## Candidate Outputs

The workflow uploads one short-lived `release-candidate-v...` Actions artifact containing:

- `UnrealEditorWebUI-v...-UE55.zip`, created only from the trusted UE package artifact.
- A SHA-256 sidecar for the ZIP.
- A CycloneDX npm SBOM generated from the exact commit's package lock.
- A normalized locked npm dependency inventory including resolved sources and integrity values.
- `provenance.json` recording the release commit, trusted UE run/job/artifact ids, and the validation claim.

The source checkout is used for version checks and dependency metadata only. It is never substituted for a missing UE package artifact.

## Triggering A Candidate

Preferred tag flow:

1. Run the protected `UE CI` workflow for the intended commit and wait for the complete UE job to succeed.
2. Update `UnrealEditorWebUI.uplugin` so `VersionName` matches the intended semantic version.
3. Create and push the matching `v...` tag on that same commit.
4. Review the `Release Candidate` summary, provenance, SBOM, archive contents, and SHA-256 before any external promotion.

For a manual rehearsal, select the exact reviewed ref in `Actions > Release Candidate > Run workflow`, enter its matching `v...` candidate tag, and supply the successful UE workflow run id.

## Packaged Bridge Smoke And Remaining Boundary

`scripts/validate-packaged-bridge-smoke.py` runs in the temporary host project created from the BuildPlugin artifact and checks the packaged React entry point plus every referenced local asset. The native automation test `UnrealEditorWebUI.Bridge.PackagedRegistryPing` separately creates `UUnrealEditorWebUIBridge` in C++ and sends `system.ping` through the production bridge into the real packaged Python registry. Keeping this call in native automation avoids exporting production bridge methods as Blueprint/Python-callable APIs solely for testing.

This commandlet smoke does not create an interactive CEF window. It therefore does not prove the final browser JavaScript `BindUObject` hop or task DOM-event delivery. Those checks require a GUI-capable, isolated Unreal runner and a C++/Slate browser automation harness. Until such a run is recorded for the release commit, provenance deliberately claims only trusted UE 5.5 BuildPlugin and repository automation—not complete browser end-to-end coverage.

## Promotion Policy

The repository currently makes no automated GitHub Release and grants this workflow no `contents: write` permission. Promotion is a separate owner-approved action after reviewing the candidate and validation evidence. The owner selected the MIT License; packaging copies the exact repository `LICENSE`, and candidate assembly rejects a missing or mismatched copy.
