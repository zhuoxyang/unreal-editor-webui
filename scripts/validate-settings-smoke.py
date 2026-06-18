"""Smoke-check the Unreal Editor WebUI native settings class inside UE.

Run with UnrealEditor-Cmd and PythonScriptPlugin, for example:

  UnrealEditor-Cmd.exe HostProject.uproject -run=pythonscript -script=scripts/validate-settings-smoke.py
"""

import sys

import unreal


def fail(message: str) -> None:
    unreal.log_error(f"Unreal Editor WebUI settings smoke failed: {message}")
    raise SystemExit(1)


settings = unreal.find_object(None, "/Script/UnrealEditorWebUI.Default__UnrealEditorWebUIEditorSettings")
if settings is None:
    settings_class = unreal.find_object(None, "/Script/UnrealEditorWebUI.UnrealEditorWebUIEditorSettings")
    if settings_class is None:
        settings_class = unreal.load_class(None, "/Script/UnrealEditorWebUI.UnrealEditorWebUIEditorSettings")

    if settings_class is None:
        fail("UUnrealEditorWebUIEditorSettings class was not loaded.")

    settings = unreal.get_default_object(settings_class)

if settings is None:
    fail("Unable to read UUnrealEditorWebUIEditorSettings default object.")

expected = [
    (("use_dev_server", "b_use_dev_server", "bUseDevServer"), False),
    (("dev_server_url", "DevServerURL"), "http://localhost:5173"),
]

for property_names, expected_value in expected:
    for property_name in property_names:
        try:
            actual_value = settings.get_editor_property(property_name)
            break
        except Exception:
            actual_value = None
    else:
        fail(f"Unable to read any expected property alias: {', '.join(property_names)}")

    if actual_value != expected_value:
        fail(f"{property_name} expected {expected_value!r}, got {actual_value!r}.")

unreal.log("Unreal Editor WebUI settings smoke passed.")
unreal.log("Expected Project Settings path: Project > Plugins > Unreal Editor WebUI")
print("Unreal Editor WebUI settings smoke passed.")
print("Expected Project Settings path: Project > Plugins > Unreal Editor WebUI")
sys.exit(0)
