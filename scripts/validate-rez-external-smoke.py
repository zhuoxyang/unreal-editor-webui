"""UE Python smoke proving core and Tool Packs load only from Rez roots."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import unreal


RESULT_ENV = "UNREAL_WEBUI_REZ_SMOKE_RESULT"
EXPECT_ENV = "UNREAL_WEBUI_REZ_SMOKE_EXPECTATIONS"


def _write_result(value: dict[str, Any]) -> None:
    output = os.environ.get(RESULT_ENV, "").strip()
    if not output:
        return
    path = Path(output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _canonical(value: str, *, must_exist: bool = True) -> Path:
    return Path(value).resolve(strict=must_exist)


def _execute(registry: Any, command: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    request = json.dumps({"id": command, "command": command, "payload": payload or {}})
    response = json.loads(registry.execute_command(request))
    if response.get("ok") is not True:
        raise RuntimeError(f"Command {command} failed: {response.get('error')}")
    return response


def _plugin_base(plugin_name: str) -> Path:
    library = getattr(unreal, "PluginBlueprintLibrary", None)
    if library is None or not hasattr(library, "get_plugin_base_dir"):
        raise RuntimeError("Unreal PluginBlueprintLibrary is unavailable.")
    value = library.get_plugin_base_dir(plugin_name)
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"Plugin {plugin_name} has no loaded base directory.")
    return _canonical(value)


def main() -> None:
    raw = os.environ.get(EXPECT_ENV, "")
    expected = json.loads(raw)
    if not isinstance(expected, dict) or set(expected) != {
        "absent",
        "present",
        "removedPythonPackage",
        "removedRoot",
        "round",
    }:
        raise RuntimeError("Rez smoke expectations use an unsupported schema.")
    present = expected["present"]
    absent = expected["absent"]
    if not isinstance(present, dict) or not isinstance(absent, list):
        raise RuntimeError("Rez smoke plugin expectations are malformed.")

    project_root = _canonical(unreal.Paths.project_dir())
    project_plugins = project_root / "Plugins"
    if project_plugins.exists() or os.path.lexists(str(project_plugins)):
        raise RuntimeError("External Rez smoke project must not contain Project/Plugins.")

    actual_bases: dict[str, str] = {}
    for plugin_name, expected_root in sorted(present.items()):
        actual = _plugin_base(plugin_name)
        required = _canonical(str(expected_root))
        if actual != required:
            raise RuntimeError(f"Plugin {plugin_name} loaded from an unexpected root.")
        try:
            actual.relative_to(project_root)
        except ValueError:
            pass
        else:
            raise RuntimeError(f"Plugin {plugin_name} loaded from inside the project.")
        actual_bases[plugin_name] = str(actual)

    import unreal_editor_webui_registry as registry

    ping = _execute(registry, "system.ping", {"source": "rez-external-e2e"})
    if ping.get("result", {}).get("message") != "pong":
        raise RuntimeError("system.ping did not return pong.")
    statuses = _execute(registry, "system.toolPacks").get("result", {}).get("packs")
    if not isinstance(statuses, list):
        raise RuntimeError("system.toolPacks returned malformed status data.")
    loaded = {
        item.get("pluginName"): item
        for item in statuses
        if isinstance(item, dict) and item.get("state") == "loaded"
    }

    expected_commands = {
        "AssetToolsFixture": "fixture.asset.echo",
        "LevelToolsFixture": "fixture.level.echo",
    }
    for plugin_name, command in expected_commands.items():
        if plugin_name in present:
            status = loaded.get(plugin_name)
            if status is None or command not in status.get("commands", []):
                raise RuntimeError(f"Tool Pack {plugin_name} did not report its command.")
            response = _execute(registry, command, {"value": expected["round"]})
            if response.get("result", {}).get("value") != expected["round"]:
                raise RuntimeError(f"Tool Pack command {command} returned the wrong value.")
        else:
            response = json.loads(
                registry.execute_command(
                    json.dumps({"id": command, "command": command, "payload": {}})
                )
            )
            if response.get("ok") is not False or response.get("error", {}).get("code") != "unknown_command":
                raise RuntimeError(f"Removed Tool Pack command {command} remained registered.")
            if plugin_name in loaded:
                raise RuntimeError(f"Removed Tool Pack {plugin_name} remained a loaded provider.")

    for plugin_name in absent:
        if any(
            isinstance(item, dict) and item.get("pluginName") == plugin_name
            for item in statuses
        ):
            raise RuntimeError(
                f"Absent Tool Pack {plugin_name} remained in raw status data."
            )
        library = getattr(unreal, "PluginBlueprintLibrary", None)
        absent_base = (
            library.get_plugin_base_dir(plugin_name)
            if library is not None and hasattr(library, "get_plugin_base_dir")
            else ""
        )
        if isinstance(absent_base, str) and absent_base.strip():
            raise RuntimeError(f"Absent Tool Pack {plugin_name} still has a plugin base directory.")
        if plugin_name in actual_bases or plugin_name in loaded:
            raise RuntimeError(f"Absent Tool Pack {plugin_name} remained visible.")
    removed_package = str(expected["removedPythonPackage"])
    if removed_package and any(
        name == removed_package or name.startswith(removed_package + ".")
        for name in sys.modules
    ):
        raise RuntimeError("Removed Tool Pack Python package remained in sys.modules.")
    removed_root = str(expected["removedRoot"])
    if removed_root:
        removed = _canonical(removed_root)
        for value in sys.path:
            if not value:
                continue
            try:
                candidate = _canonical(value, must_exist=False)
            except (OSError, RuntimeError):
                continue
            if candidate == removed or removed in candidate.parents or candidate in removed.parents:
                raise RuntimeError("Removed Tool Pack root remained in sys.path.")

    _write_result(
        {
            "externalPluginRoots": sorted(actual_bases),
            "loadedProviders": sorted(loaded),
            "ok": True,
            "processId": os.getpid(),
            "pythonStateClean": True,
            "round": expected["round"],
            "schemaVersion": 1,
        }
    )
    unreal.log(f"Unreal Editor WebUI Rez external smoke round {expected['round']} passed.")


try:
    main()
except Exception as error:
    _write_result({"errorCode": "rez_external_smoke_failed", "ok": False, "schemaVersion": 1})
    unreal.log_error(f"Unreal Editor WebUI Rez external smoke failed: {error}")
    raise
