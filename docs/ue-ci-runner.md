# UE CI Runner Setup

CI has two trust layers:

- `.github/workflows/ci.yml` runs frontend, Python, descriptor/module-wiring, and script-syntax checks on GitHub-hosted infrastructure for every pull request, including public fork pull requests.
- `.github/workflows/ue-ci.yml` has no `pull_request` trigger. Its hosted prerequisite jobs and `UE 5.5 BuildPlugin and automation` run only for a matching push to `main`, or for a manually dispatched workflow. The self-hosted job additionally requires the `Run UE validation on the protected self-hosted runner` input for a manual run. It packages the plugin, creates a temporary host project, runs `UnrealEditorWebUI.` automation tests, runs the settings smoke script, and uploads logs/artifacts.

Public `pull_request` events cannot trigger the UE workflow or schedule its self-hosted job. Both workflows have read-only `contents` permission and every checkout disables persisted GitHub credentials.

## Protect The Self-Hosted Environment

Create a GitHub Actions environment named `ue-self-hosted` before enabling the UE job:

1. Open `Settings > Environments > New environment` and use the exact name `ue-self-hosted`.
2. Add required reviewers and, where the plan supports it, prevent self-review.
3. Restrict deployment branches to `main` initially. Add another protected branch only when maintainers intentionally need pre-merge UE validation for that reviewed ref.
4. Do not add repository write tokens or unrelated production secrets to this environment.

For a trusted manual run, choose a reviewed repository ref in `Actions > UE CI > Run workflow` and enable the self-hosted validation input. Environment approval is still required. Never approve a manual self-hosted run for unreviewed code from a public contribution.

## Required Runner Labels

The self-hosted Windows runner must have these labels:

- `self-hosted`
- `windows`
- `ue-5.5`

## Prerequisites

Install these before registering the runner:

- Unreal Engine 5.5 at `C:\Program Files\Epic Games\UE_5.5`.
- Visual Studio 2022 C++ toolchain and Windows SDK.
- Git.
- PowerShell 7 or Windows PowerShell 5.1.
- Node.js/npm compatible with `frontend/package.json`.
- A clean Unreal Python startup environment. User-global `Documents/UnrealEngine/Python/init_unreal.py` scripts should not log errors during commandlets.

## Register The Runner

Create a short-lived registration token in GitHub:

`Settings > Actions > Runners > New self-hosted runner`

Then run PowerShell as the service account that should execute CI:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-ue-runner.ps1 `
  -RepoUrl "https://github.com/zhuoxyang/unreal-editor-webui" `
  -Token "<registration-token>" `
  -RunnerVersion "2.336.0" `
  -RunnerSha256 "d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162" `
  -InstallService
```

The script downloads an explicitly pinned Windows x64 runner, verifies its SHA-256 before extraction, validates UE/Node prerequisites, configures labels `self-hosted,windows,ue-5.5`, and optionally installs/starts the runner service. The checked-in defaults are:

- Runner version: `2.336.0`.
- Official Windows x64 SHA-256: `d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162`.

These values come from the [official `actions/runner` `v2.336.0` release notes](https://github.com/actions/runner/releases/tag/v2.336.0). The script constructs the exact versioned GitHub release URL; it never downloads the mutable `latest` asset and never extracts an archive whose digest does not match.

For a reviewed runner upgrade, update `RunnerVersion` and `RunnerSha256` together from the official release notes, inspect the upstream changes, and provision a clean runner root. The parameters can be overridden for a staged upgrade, but both an explicit version and a 64-character SHA-256 remain mandatory. If an existing runner root contains a different version, setup fails closed instead of silently reusing it.

To run interactively instead of as a service, omit `-InstallService` and start:

```powershell
C:\actions-runner-unreal-editor-webui\run.cmd
```

## Branch Protection

Mark the hosted jobs from `.github/workflows/ci.yml` as required pull-request checks:

- `Frontend (Node ...)`
- `Python registry (Python ...)`
- `Repository checks`

Do not make any `.github/workflows/ue-ci.yml` job a pull-request required check: that workflow deliberately has no `pull_request` trigger.

## External Runner Availability

Unreal Engine is not installed on the GitHub-hosted runners used by this repository. A trusted UE run therefore remains queued until an online runner with the `self-hosted`, `windows`, and `ue-5.5` labels is available and the `ue-self-hosted` environment is approved. This is an external infrastructure blocker, not a reason to route public pull-request code to a persistent machine.

Hosted checks can validate source-level configuration but do not compile the C++ module or execute Unreal automation. Do not treat a commit as UE-validated, package it for release, or promote it solely because the hosted checks passed; record a successful trusted UE run for that exact commit.

## Artifacts

The UE workflow uploads:

- `unreal-editor-webui-ue-logs`: editor, AutomationTool, and smoke-test logs.
- `UnrealEditorWebUI-Package-UE55`: packaged plugin output only after the complete trusted UE job succeeds.

Log artifacts use `if: always()` so failed UE runs preserve useful diagnostics. The package artifact uses `if: success()` and a missing package fails the upload instead of publishing a partial build.
