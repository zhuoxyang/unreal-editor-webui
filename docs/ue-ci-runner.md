# UE CI Runner Setup

`.github/workflows/ue-ci.yml` has two layers:

- `UE config validation (hosted)` runs on `ubuntu-latest` for every matching pull request. It validates the plugin descriptor, module wiring, Python bridge entry presence, and script syntax without requiring Unreal Engine.
- `UE 5.5 BuildPlugin and automation` runs on a licensed Windows self-hosted runner with Unreal Engine 5.5. It packages the plugin, creates a temporary host project, runs `UnrealEditorWebUI.` automation tests, runs the settings smoke script, and uploads logs/artifacts.

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
  -InstallService
```

The script downloads the latest Windows x64 GitHub Actions runner, validates UE/Node prerequisites, configures labels `self-hosted,windows,ue-5.5`, and optionally installs/starts the runner service.

To run interactively instead of as a service, omit `-InstallService` and start:

```powershell
C:\actions-runner-unreal-editor-webui\run.cmd
```

## Branch Protection

After the runner is online, mark these checks as required for pull requests that touch plugin code:

- `UE config validation (hosted)`
- `UE 5.5 BuildPlugin and automation`

Keep the hosted job required even if the self-hosted runner is temporarily offline; it gives fast feedback for descriptor and script regressions on every PR.

## Artifacts

The UE workflow uploads:

- `unreal-editor-webui-ue-logs`: editor, AutomationTool, and smoke-test logs.
- `UnrealEditorWebUI-Package-UE55`: packaged plugin output when packaging reached that step.

Artifacts are uploaded with `if: always()` so failed UE runs still preserve useful diagnostics.
