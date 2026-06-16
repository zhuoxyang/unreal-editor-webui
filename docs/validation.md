# Validation

## Latest Local Validation

- Frontend build: passed with `npm run build`.
- Frontend lint: passed with `npm run lint`.
- Plugin descriptor JSON: passed with `python3 -m json.tool UnrealEditorWebUI.uplugin`.
- Python syntax: passed with `python3 -m py_compile Python/*.py`.
- Whitespace diff check: passed with `git diff --check`.
- UE 5.7 BuildPlugin: passed on macOS arm64+x64 with `scripts/package-plugin.sh`.

## UE 5.5 Status

UE 5.5 is still pending validation because this machine only has `UE_5.7` installed under `/Users/Shared/Epic Games`.

When a UE 5.5 installation is available, run:

```sh
bash scripts/package-plugin.sh \
  "/path/to/UE_5.5/Engine/Build/BatchFiles/RunUAT.sh" \
  /tmp/UnrealEditorWebUI-UE55-Package
```
