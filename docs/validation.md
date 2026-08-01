# Validation

## Latest Local Validation

Windows source validation on 2026-08-02:

- Frontend build: passed with `npm run build`.
- Frontend lint: passed with `npm run lint`.
- Frontend tests: passed with `npm test` (93 tests in 17 files).
- Frontend dependency audit: passed with 0 vulnerabilities.
- Plugin descriptor JSON: passed with `python -m json.tool UnrealEditorWebUI.uplugin`.
- Python syntax: passed with `python -m compileall` across plugin Python, tests, and smoke scripts.
- Python registry tests: passed with `python -m unittest discover -s tests -v` (42 tests).
- Workflow/dependabot YAML parsing, PowerShell AST parsing, shell syntax, release-helper syntax, immutable action references, and whitespace validation: passed; artifact ZIP digest tests passed (2 tests).
- SBOM and locked dependency inventory generation: passed and produced 301 npm components/packages.

Unreal Engine 5.5 is not installed in this local environment. The current C++ bridge/session changes, packaged smoke, and release-candidate artifact chain therefore still require the protected trusted UE runner before this commit can be described as release-validated.

Historical local UE 5.5 evidence from 2026-06-20 (before the current changes):

- UE 5.5 BuildPlugin passed on Windows 11 with `C:\Program Files\Epic Games\UE_5.5\Engine\Build\BatchFiles\RunUAT.bat`.
- Packaging passed from lockfile install through React build and UE packaging; the package contained `Web/dist/index.html` and excluded local docs, frontend sources, and unrelated untracked files.
- The settings smoke loaded `UUnrealEditorWebUIEditorSettings` in a temporary host project. Its script passed, while the commandlet reported a non-zero exit because a user-global Unreal Python startup script logged an unrelated error before the smoke ran.

CI coverage added in `.github/workflows/ci.yml`:

- Node 20.19 and 22.13 frontend install/build/lint/test and packaged frontend entry-point validation on GitHub-hosted runners.
- Python 3.9 and 3.11 descriptor, syntax, and registry unit tests on GitHub-hosted runners.
- Repository descriptor/module-wiring, script-syntax, and tracked-file whitespace checks on a GitHub-hosted runner. The whitespace check compares Git's empty tree with `HEAD`, so it covers every tracked file even on a clean checkout and works for an initial commit; legacy extra blank lines at EOF remain tolerated.
- Workflow-level `contents: read` permission and checkout with persisted GitHub credentials disabled.

UE CI coverage is defined in `.github/workflows/ue-ci.yml`:

- The UE workflow has no `pull_request` trigger. Automatic pull-request validation is provided entirely by the GitHub-hosted jobs in `.github/workflows/ci.yml`, including equivalent descriptor/module-wiring and script-syntax checks.
- The UE workflow's hosted prerequisite jobs run only on its trusted events. `UE 5.5 BuildPlugin and automation` is eligible only for a push to `main`, or an explicit trusted `workflow_dispatch` with the self-hosted validation input enabled, and it is gated by the protected `ue-self-hosted` environment.
- Runner labels: `self-hosted`, `windows`, `ue-5.5`.
- Runner environment variable: `UE_ROOT=C:\Program Files\Epic Games\UE_5.5`.
- Required software: Unreal Engine 5.5, Visual Studio 2022 C++ toolchain, Windows SDK, Node.js/npm, Git, PowerShell.
- The self-hosted job runs `scripts/package-plugin.ps1`, verifies the packaged `Web/dist/index.html`, creates a temporary host project with `scripts/create-host-project.ps1`, runs the `UnrealEditorWebUI.` automation test filter, executes the packaged bridge smoke, and runs `scripts/validate-settings-smoke.py`.
- UE logs upload with `if: always()` so failed runs keep diagnostics when files exist. The HostProject log glob points to the temporary host project directory.
- The packaged plugin uploads only when the full UE job succeeds; missing package output is an artifact error.
- Keep self-hosted runner user Python startup scripts clean or isolated. A global `Documents/UnrealEngine/Python/init_unreal.py` can pollute settings-smoke commandlet exit status.

Unreal validation depends on an external licensed runner. If no correctly labelled runner is online, or the protected environment is not approved, the trusted UE job remains queued. Hosted checks do not compile the C++ module or replace a successful UE run for the exact commit being promoted.

## Packaged Bridge Smoke

After `scripts/create-host-project.ps1` copies the trusted BuildPlugin output into a temporary project, run the executable packaged smoke with Unreal Engine 5.5:

```powershell
$env:UNREAL_WEBUI_PACKAGED_SMOKE_RESULT = Join-Path $env:TEMP "UnrealEditorWebUI-PackagedSmoke.json"
& "C:\Program Files\Epic Games\UE_5.5\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" `
  $HostProject `
  -run=pythonscript `
  "-script=$PWD/scripts/validate-packaged-bridge-smoke.py" `
  -unattended -nopause -nosplash -NullRHI
if ($LASTEXITCODE -ne 0) { throw "Packaged bridge smoke failed with exit code $LASTEXITCODE" }
```

The script verifies the packaged `Web/dist/index.html` and its local script/stylesheet files. The preceding native automation suite includes `UnrealEditorWebUI.Bridge.PackagedRegistryPing`, which creates `UUnrealEditorWebUIBridge` in C++ and executes `system.ping` through the production bridge into the real packaged Python registry. The split avoids exporting production bridge methods as Blueprint/Python-callable APIs solely for a test. The commandlet's optional JSON result records only the frontend-asset scope it directly covers.

This commandlet does not create an interactive CEF browser, so it deliberately reports `cefBrowserToBindUObject` and `taskDomEventDelivery` as unverified. Completing those final hops requires a GUI-capable, isolated Unreal runner plus a C++/Slate browser automation harness. A hosted check or this commandlet smoke alone must not be described as full browser end-to-end validation.

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

Run the packaging helper that matches your platform. The script stages a clean plugin copy and then calls `RunUAT BuildPlugin`.

macOS/Linux:

```sh
bash scripts/package-plugin.sh \
  "/path/to/UE_5.5/Engine/Build/BatchFiles/RunUAT.sh" \
  /tmp/UnrealEditorWebUI-Package
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-plugin.ps1 `
  "C:\Program Files\Epic Games\UE_5.5\Engine\Build\BatchFiles\RunUAT.bat" `
  "$env:TEMP\UnrealEditorWebUI-Package"
```

Unreal Engine 5.5 on Windows is the current automated target. Validate another engine/platform combination on a licensed runner before describing it as supported.
