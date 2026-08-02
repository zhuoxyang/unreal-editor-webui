# Validation

## Latest Local Validation

Frontend coverage validation on 2026-08-03 with Node 24.18.1:

- `npm ci`, `npm run test:coverage`, `npm run build`, and `npm run lint` passed; the dependency audit reported 0 vulnerabilities.
- All 134 tests in 19 files passed. The measured production-source baseline was 78.05% statements, 74.56% branches, 77.71% functions, and 78.73% lines.
- The enforced global floors are 75% statements, 72% branches, 75% functions, and 76% lines, leaving approximately 2.5-3 percentage points of headroom from the measured baseline.
- Coverage includes production `src` TypeScript and TSX, including runtime helpers under `src/types`; test files, test setup, `main.tsx`, and declaration files are excluded. Reports are written under the ignored `Saved/FrontendCoverage` directory.

Windows source validation on 2026-08-02:

- Frontend build: passed with `npm run build`.
- Frontend lint: passed with `npm run lint`.
- Frontend tests: passed with `npm test` (94 tests in 17 files).
- Frontend dependency audit: passed with 0 vulnerabilities.
- Plugin descriptor JSON: passed with `python -m json.tool UnrealEditorWebUI.uplugin`.
- Python syntax: passed with `python -m compileall` across plugin Python, tests, and smoke scripts.
- Python registry tests: passed with `python -m unittest discover -s tests -v` (42 tests).
- Workflow/dependabot YAML parsing, PowerShell AST parsing, shell syntax, release-helper syntax, immutable action references, and whitespace validation: passed; release-artifact verification tests passed (28 tests).
- SBOM and locked dependency inventory generation: passed and produced 301 npm components/packages.

Local Unreal inventory and auxiliary validation on 2026-08-02:

- Unreal Engine 5.1.1, 5.3.2, and 5.8.1 are installed; Unreal Engine 5.5 is not installed.
- UE 5.8.1 `BuildPlugin` passed from a fresh staging directory on Windows with Visual Studio 2022, MSVC 14.44.35228, and Windows SDK 10.0.22621.0. The packaged MIT `LICENSE` matched the repository SHA-256 (`a1ff542acadcc7847fba925b0b82474d1de27ae18c4804564eb76a302f4f19d5`).
- All 9 required `UnrealEditorWebUI.` native Automation tests passed against a host project created from that fresh package, including the real packaged Python registry path and the new authorization, lifecycle, and N/N+1 resource-limit coverage.
- The packaged frontend smoke passed with its classic IIFE asset validated and no `file://` module entry; the native settings smoke passed with 0 errors.
- `UnrealEditorWebUI.Browser.CEFBindingAndTaskEvent` passed in the real UE 5.8 GUI editor. It verified the packaged React page, temporary CEF UObject binding, bridge-ready state, `system.ping` task, DOM event log, and completed TaskCard round trip without a plugin warning.
- UE 5.3.2 `BuildPlugin`, native Automation, packaged frontend smoke, and settings smoke also passed earlier as compatibility evidence. UE 5.3 remains compatibility-only.
- This local UE 5.8.1 run validates the implementation and package. The final release commit still requires the protected exact-commit UE 5.8 GUI workflow and `UE58` artifact before it can be described as release-validated.

Historical local UE 5.5 evidence from 2026-06-20 (before the current changes):

- UE 5.5 BuildPlugin passed on Windows 11 with `C:\Program Files\Epic Games\UE_5.5\Engine\Build\BatchFiles\RunUAT.bat`.
- Packaging passed from lockfile install through React build and UE packaging; the package contained `Web/dist/index.html` and excluded local docs, frontend sources, and unrelated untracked files.
- The settings smoke loaded `UUnrealEditorWebUIEditorSettings` in a temporary host project. Its script passed, while the commandlet reported a non-zero exit because a user-global Unreal Python startup script logged an unrelated error before the smoke ran.

CI coverage added in `.github/workflows/ci.yml`:

- Node 22.22.2 and 24.18.1 frontend install/build/lint and packaged frontend entry-point validation on GitHub-hosted runners. Node 22.22.2 runs the ordinary test command, while Node 24.18.1 runs the complete suite once with the production-source coverage gates; Node 24.18.1 is also pinned for local packaging, Unreal validation, and release tooling through `.nvmrc`.
- Python 3.9 and 3.11 descriptor, syntax, and registry unit tests on GitHub-hosted runners.
- A Windows-hosted Node 24.18.1 packaging-contract job that exercises the real Windows PowerShell 5.1 and `.cmd` branches, including scoped AutomationTool environment inheritance, failure-code propagation, and success/failure artifact fixtures without requiring Unreal Engine.
- Repository descriptor/module-wiring, script-syntax, and tracked-file whitespace checks on a GitHub-hosted runner. The whitespace check compares Git's empty tree with `HEAD`, so it covers every tracked file even on a clean checkout and works for an initial commit; legacy extra blank lines at EOF remain tolerated.
- Workflow-level `contents: read` permission and checkout with persisted GitHub credentials disabled.

UE CI coverage is defined in `.github/workflows/ue-ci.yml`:

- The UE workflow has no `pull_request` trigger. Automatic pull-request validation is provided entirely by the GitHub-hosted jobs in `.github/workflows/ci.yml`, including equivalent descriptor/module-wiring and script-syntax checks.
- The UE workflow's hosted prerequisite jobs run only on its trusted events. A push to `main` always selects `UE 5.8 BuildPlugin and automation`; an explicit trusted `workflow_dispatch` can select UE 5.3 compatibility validation or UE 5.8 release validation, and the self-hosted job is gated by the protected `ue-self-hosted` environment.
- Runner labels: `self-hosted`, `windows`, `gui`, plus the selected `ue-5.3` or `ue-5.8` engine label.
- Runner environment variable: `UE_ROOT` resolves to the matching standard Epic installation path.
- Required software: the selected Unreal Engine version, a compatible Visual Studio C++ toolchain, Windows SDK, Git, and PowerShell. This repository's UE 5.8 runner baseline accepts Visual Studio 2022 17.14 with an MSVC compiler product version of 14.44.35211 or later within the 14.44 family, or Visual Studio 2026 18.x with 14.50.35723 or later within the 14.50 family. The check follows UnrealBuildTool in reading `cl.exe` product version instead of assuming the servicing version from its family directory name; the engine configuration bans MSVC 14.39 and the early portions of those newer families. The pinned `actions/setup-node` step provisions the repository-compatible Node.js/npm toolchain.
- The self-hosted job runs `scripts/package-plugin.ps1`, verifies the packaged `Web/dist/index.html` and exact repository `LICENSE`, creates a temporary host project with `scripts/create-host-project.ps1`, runs the headless Bridge/Settings automation filters, executes the packaged bridge and settings smokes, and then runs `UnrealEditorWebUI.Browser.CEFBindingAndTaskEvent` in the real GUI editor. It checks every required Automation path, a fresh structured packaged-smoke result, and explicit success markers for both Python smokes rather than trusting process exit codes alone.
- UE logs upload with `if: always()` after fresh scoped paths are successfully prepared, so failed runs keep current-run diagnostics without uploading a pre-existing same-attempt path. `RunUAT` writes directly to `%RUNNER_TEMP%\UnrealEditorWebUI-AutomationToolLogs-<run-id>-<run-attempt>` through matching `uebp_LogFolder` and `uebp_FinalLogFolder` values, and a sibling BuildPlugin console capture covers failures before the UAT logger starts. The workflow never reads or copies the persistent AppData AutomationTool history. Every editor log, structured result, browser report, and host-project log upload path is also bound to that exact run id and attempt.
- The packaged plugin uploads only after all UE validation steps succeed; missing package output is an artifact error. The always-run diagnostics upload follows it, so a later artifact-service failure cannot prevent an already validated package from being uploaded, while the overall failed run remains ineligible for release.
- Keep self-hosted runner user Python startup scripts clean or isolated. A global `Documents/UnrealEngine/Python/init_unreal.py` can pollute settings-smoke commandlet exit status.

Unreal validation depends on an external licensed runner. If no correctly labelled interactive runner is online, or the protected environment is not approved, the trusted UE job remains queued. Hosted checks do not compile the C++ module. A successful UE 5.3 run is compatibility evidence but cannot replace the successful exact-commit UE 5.8 GUI run required for release promotion.

## Packaged Bridge Smoke

After `scripts/create-host-project.ps1` copies the trusted BuildPlugin output into a temporary project, run the executable packaged smoke with Unreal Engine 5.8:

```powershell
$env:UNREAL_WEBUI_PACKAGED_SMOKE_RESULT = Join-Path $env:TEMP "UnrealEditorWebUI-PackagedSmoke.json"
& "C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" `
  $HostProject `
  -run=pythonscript `
  "-script=$PWD/scripts/validate-packaged-bridge-smoke.py" `
  -unattended -nopause -nosplash -NullRHI
if ($LASTEXITCODE -ne 0) { throw "Packaged bridge smoke failed with exit code $LASTEXITCODE" }
```

The script verifies the packaged `Web/dist/index.html` and its local script/stylesheet files. The preceding native automation suite includes `UnrealEditorWebUI.Bridge.PackagedRegistryPing`, which creates `UUnrealEditorWebUIBridge` in C++ and executes `system.ping` through the production bridge into the real packaged Python registry. The split avoids exporting production bridge methods as Blueprint/Python-callable APIs solely for a test. The commandlet's optional JSON result records only the frontend-asset scope it directly covers.

This commandlet does not create an interactive CEF browser, so its own structured result deliberately reports `cefBrowserToBindUObject` and `taskDomEventDelivery` as unverified. The formal UE job covers those final hops separately with `UnrealEditorWebUI.Browser.CEFBindingAndTaskEvent` on an interactive `gui` runner. A hosted check or the commandlet smoke alone must not be described as full browser end-to-end validation.

Historical UE validation (retained as evidence, not a maintained compatibility guarantee):

- UE 5.7 BuildPlugin: passed on macOS arm64+x64 with `scripts/package-plugin.sh`.
- UE 5.7 real project smoke test: passed with `/Users/zhuolyang/Documents/Unreal Projects/nuts/nuts.uproject`.

## Real Project Smoke Test

Project:

```text
/Users/zhuolyang/Documents/Unreal Projects/nuts/nuts.uproject
```

Validated:

- Plugin copied into `Plugins/UnrealEditorWebUI`.
- `PythonScriptPlugin` enabled in the project.
- `UnrealEditorWebUI` enabled in the project for the editor target.
- Frontend built into `Web/dist`.
- Project compiled with the plugin.
- UE Editor opened the project successfully.
- `Window > Unreal Editor WebUI` loaded the demo Web UI successfully.

## BuildPlugin Commands

Run the packaging helper that matches your platform. The script stages a clean plugin copy and then calls `RunUAT BuildPlugin`; Unreal's packaging filter includes the repository `LICENSE`, and the helper rejects a missing or mismatched packaged copy.

macOS/Linux:

```sh
bash scripts/package-plugin.sh \
  "/path/to/UE_5.8/Engine/Build/BatchFiles/RunUAT.sh" \
  /tmp/UnrealEditorWebUI-Package
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-plugin.ps1 `
  "C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\RunUAT.bat" `
  "$env:TEMP\UnrealEditorWebUI-Package"
```

Unreal Engine 5.8 on Windows is the current automated target. Validate another engine/platform combination on a licensed runner before describing it as supported.
