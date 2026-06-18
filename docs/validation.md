# Validation

## Latest Local Validation

Windows local validation on 2026-06-18:

- Frontend build: passed with `npm run build`.
- Frontend lint: passed with `npm run lint`.
- Plugin descriptor JSON: passed with `python3 -m json.tool UnrealEditorWebUI.uplugin`.
- Python syntax: passed with `python3 -m py_compile Python/*.py`.
- Python registry tests: passed with `python -m unittest discover -s tests` (15 tests).
- Windows packaging script missing-RunUAT failure path: passed with `powershell -ExecutionPolicy Bypass -File scripts/package-plugin.ps1 Z:\missing\RunUAT.bat $env:TEMP\UnrealEditorWebUI-MissingRunUAT`.
- Whitespace diff check: passed with `git diff --check` (Windows line-ending warnings only).
- UE native settings integration was source-reviewed against `UDeveloperSettings` APIs, but not BuildPlugin-compiled on this Windows machine because no local Unreal Engine `RunUAT` path is discoverable.

CI coverage added in `.github/workflows/ci.yml`:

- Node 22 frontend install/build/lint.
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

Use the same pattern for UE 5.5 or UE 5.6 by replacing the engine directory. The current Windows machine used for local validation does not have a discoverable Unreal Engine `RunUAT` path, so BuildPlugin was not rerun here.
