# Validation

## Latest Local Validation

Windows local validation on 2026-06-20:

- Frontend build: passed with `npm run build`.
- Frontend lint: passed with `npm run lint`.
- Frontend tests: passed with `npm test` (10 tests across schema coercion, result rendering, and task recovery).
- Frontend dependency audit: passed with 0 vulnerabilities after the clean packaging install.
- Plugin descriptor JSON: passed with `python3 -m json.tool UnrealEditorWebUI.uplugin`.
- Python syntax: passed with `python3 -m py_compile Python/*.py`.
- Python registry tests: passed with `python -m unittest discover -s tests` (19 tests).
- Windows packaging script missing-RunUAT failure path: passed with `powershell -ExecutionPolicy Bypass -File scripts/package-plugin.ps1 Z:\missing\RunUAT.bat $env:TEMP\UnrealEditorWebUI-MissingRunUAT`.
- Whitespace diff check: passed with `git diff --check` (Windows line-ending warnings only).
- UE 5.5 BuildPlugin: passed on Windows 11 with `C:\Program Files\Epic Games\UE_5.5\Engine\Build\BatchFiles\RunUAT.bat`.
- UE 5.5 BuildPlugin output: `C:\Users\zhuolyang\AppData\Local\Temp\UnrealEditorWebUI-Package-20260620202507`.
- Packaging helper smoke: passed from lockfile install through React build and UE packaging. The package contains `Web/dist/index.html` and excludes local docs, frontend sources, and unrelated untracked files.
- UE 5.5 settings smoke (last rerun 2026-06-18): `scripts/validate-settings-smoke.py` loaded `UUnrealEditorWebUIEditorSettings` in a temporary host project and confirmed the expected Project Settings path `Project > Plugins > Unreal Editor WebUI`. The smoke script passed; the commandlet process reported a non-zero exit because a user-global `C:/Users/zhuolyang/Documents/UnrealEngine/Python/init_unreal.py` startup script logged an unrelated LightAI error before the smoke script ran.

CI coverage added in `.github/workflows/ci.yml`:

- Node 22 frontend install/build/lint/test and packaged frontend entry-point validation.
- Python 3.11 descriptor, syntax, registry unit tests, and whitespace validation.

Historical UE validation:

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
  "/path/to/UE_5.7/Engine/Build/BatchFiles/RunUAT.sh" \
  /tmp/UnrealEditorWebUI-Package
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-plugin.ps1 `
  "C:\Program Files\Epic Games\UE_5.7\Engine\Build\BatchFiles\RunUAT.bat" `
  "$env:TEMP\UnrealEditorWebUI-Package"
```

Use the same pattern for UE 5.6 or newer by replacing the engine directory.
