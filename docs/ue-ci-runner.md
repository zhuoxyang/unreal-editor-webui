# UE CI Runner Setup

CI has two trust layers:

- `.github/workflows/ci.yml` runs frontend, Python, descriptor/module-wiring, and script-syntax checks on GitHub-hosted infrastructure for every pull request, including public fork pull requests.
- `.github/workflows/ue-ci.yml` has no `pull_request` trigger. Its hosted prerequisite jobs and trusted BuildPlugin job run only for a matching push to `main`, or for a manually dispatched workflow. The self-hosted job additionally requires the `Run UE validation on the protected self-hosted runner` input for a manual run. Manual runs can select UE 5.3 for compatibility evidence or UE 5.8 for release evidence; pushes to `main` always select UE 5.8. The job packages the plugin, creates a version-matched temporary host project, runs native/headless checks, runs the real GUI CEF round trip, and uploads logs/artifacts.

Public `pull_request` events cannot trigger the UE workflow or schedule its self-hosted job. Both workflows have read-only `contents` permission and every checkout disables persisted GitHub credentials.

## Protect The Self-Hosted Environment

Create a GitHub Actions environment named `ue-self-hosted` before enabling the UE job:

1. Open `Settings > Environments > New environment` and use the exact name `ue-self-hosted`.
2. Add required reviewers and, where the plan supports it, prevent self-review.
3. Restrict deployment branches to `main` initially. Add another protected branch only when maintainers intentionally need pre-merge UE validation for that reviewed ref.
4. Do not add repository write tokens or unrelated production secrets to this environment.

For a trusted manual run, choose a reviewed repository ref in `Actions > UE CI > Run workflow`, enable the self-hosted validation input, and select the installed engine version. Environment approval is still required. Never approve a manual self-hosted run for unreviewed code from a public contribution. A UE 5.3 run is compatibility evidence only: its job and artifact names deliberately do not satisfy the UE 5.8 release-candidate verifier.

## Required Runner Labels

Every self-hosted Windows runner must have these labels:

- `self-hosted`
- `windows`
- `gui`
- Exactly one installed-engine label such as `ue-5.3` or `ue-5.8`.

## Prerequisites

Install these before registering the runner:

- Unreal Engine at the matching standard path, for example UE 5.3 at `C:\Program Files\Epic Games\UE_5.3` or UE 5.8 at `C:\Program Files\Epic Games\UE_5.8`.
- Visual Studio C++ toolchain and Windows SDK. This repository's maintained UE 5.8 runner baseline accepts Visual Studio 2022 17.14 with an MSVC compiler product version of 14.44.35211 or later within the 14.44 family, or Visual Studio 2026 18.x with 14.50.35723 or later within the 14.50 family. Like UnrealBuildTool, setup reads the `cl.exe` product version instead of treating the servicing toolset's family directory name as the compiler version. UE 5.8 rejects MSVC 14.39 and the early portions of those newer families according to the engine's own Windows SDK configuration.
- Git.
- PowerShell 7 or Windows PowerShell 5.1.
- Network access for the pinned `actions/setup-node` step; the UE job installs the repository's required Node.js/npm version before validation.
- A clean Unreal Python startup environment. User-global `Documents/UnrealEngine/Python/init_unreal.py` scripts should not log errors during commandlets.

## Register The Runner

Create a short-lived registration token in GitHub:

`Settings > Actions > Runners > New self-hosted runner`

Then run PowerShell from the logged-in desktop account that should execute CI:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-ue-runner.ps1 `
  -RepoUrl "https://github.com/zhuoxyang/unreal-editor-webui" `
  -Token "<registration-token>" `
  -RunnerVersion "2.336.0" `
  -RunnerSha256 "d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162" `
  -Ephemeral
```

The script requires a new or empty runner root, downloads an explicitly pinned Windows x64 runner, verifies its SHA-256 before extraction, validates the standard-path UE installation, and configures labels `self-hosted,windows,gui,ue-5.8`. Reusing a previously populated root is intentionally rejected because a version string cannot establish the integrity of all runner files. Start this GUI runner interactively from the logged-in console session; a Windows service runs in Session 0 and cannot provide valid CEF coverage. The workflow also verifies that its process and an Explorer desktop share a nonzero Windows session before claiming GUI coverage. The checked-in defaults are:

- Runner version: `2.336.0`.
- Official Windows x64 SHA-256: `d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162`.

These values come from the [official `actions/runner` `v2.336.0` release notes](https://github.com/actions/runner/releases/tag/v2.336.0). The script constructs the exact versioned GitHub release URL; it never downloads the mutable `latest` asset and never extracts an archive whose digest does not match.

For a reviewed runner upgrade, update `RunnerVersion` and `RunnerSha256` together from the official release notes, inspect the upstream changes, and provision a clean runner root. The parameters can be overridden for a staged upgrade, but both an explicit version and a 64-character SHA-256 remain mandatory. Setup fails closed for every populated runner root instead of trusting files merely because `Runner.Listener` reports the requested version.

For a short-lived UE 5.3 compatibility runner, override the version-specific settings, enable one-job ephemeral registration, and omit `-InstallService`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-ue-runner.ps1 `
  -RepoUrl "https://github.com/zhuoxyang/unreal-editor-webui" `
  -Token "<registration-token>" `
  -RunnerRoot "C:\actions-runner-unreal-editor-webui-ue53" `
  -RunnerName "$env:COMPUTERNAME-ue-5.3" `
  -UERoot "C:\Program Files\Epic Games\UE_5.3" `
  -Labels "self-hosted,windows,gui,ue-5.3" `
  -Ephemeral
```

The `gui` runner must run interactively. Omit `-InstallService` and start:

```powershell
C:\actions-runner-unreal-editor-webui-ue58\run.cmd
```

## Branch Protection

Mark the hosted jobs from `.github/workflows/ci.yml` as required pull-request checks:

- `Frontend (Node ...)`
- `Python registry (Python ...)`
- `Repository checks`

Do not make any `.github/workflows/ue-ci.yml` job a pull-request required check: that workflow deliberately has no `pull_request` trigger.

## External Runner Availability

Unreal Engine is not installed on the GitHub-hosted runners used by this repository. A trusted UE run therefore remains queued until an online interactive runner with the `self-hosted`, `windows`, `gui`, and selected `ue-5.3` or `ue-5.8` label is available and the `ue-self-hosted` environment is approved. This is an external infrastructure blocker, not a reason to route public pull-request code to a persistent machine.

Hosted checks can validate source-level configuration but do not compile the C++ module or execute Unreal automation. Do not treat a commit as UE-validated, package it for release, or promote it solely because the hosted checks passed; record a successful trusted UE run for that exact commit.

## Artifacts

The UE workflow uploads:

- `unreal-editor-webui-ue-logs`: editor, AutomationTool, and smoke-test logs.
- `UnrealEditorWebUI-Package-UE53`: compatibility-only packaged plugin output after a successful manual UE 5.3 run.
- `UnrealEditorWebUI-Package-UE58`: release-eligible packaged plugin output only after a successful UE 5.8 GUI run.

Log artifacts use `if: always()` so failed UE runs preserve useful diagnostics. The package artifact uses `if: success()` and a missing package fails the upload instead of publishing a partial build.
