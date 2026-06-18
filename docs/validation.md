# Validation

## Latest Local Validation

Windows local validation on 2026-06-18:

- Frontend build: passed with `npm run build`.
- Frontend lint: passed with `npm run lint`.
- Plugin descriptor JSON: passed with `python3 -m json.tool UnrealEditorWebUI.uplugin`.
- Python syntax: passed with `python3 -m py_compile Python/*.py`.
- Python registry permission policy smoke test: passed with a stub `unreal` module.
- Whitespace diff check: passed with `git diff --check` (Windows line-ending warnings only).

Historical validation:

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

## UE 5.5 Status

UE 5.5 is still pending validation because this machine only has `UE_5.7` installed under `/Users/Shared/Epic Games`.

When a UE 5.5 installation is available, run:

```sh
bash scripts/package-plugin.sh \
  "/path/to/UE_5.5/Engine/Build/BatchFiles/RunUAT.sh" \
  /tmp/UnrealEditorWebUI-UE55-Package
```
