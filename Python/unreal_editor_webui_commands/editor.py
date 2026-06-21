from __future__ import annotations

from typing import Any

import unreal

from unreal_editor_webui_registry import command


def _asset_to_dict(asset: Any) -> dict[str, str]:
    asset_class = asset.get_class() if hasattr(asset, "get_class") else None
    return {
        "name": asset.get_name() if hasattr(asset, "get_name") else str(asset),
        "path": asset.get_path_name() if hasattr(asset, "get_path_name") else "",
        "className": asset_class.get_name() if asset_class and hasattr(asset_class, "get_name") else "",
    }


@command(
    "editor.projectInfo",
    description="Return basic project information from the Unreal Editor.",
    permission="read",
    category="Editor",
    icon="folder",
    tags=["project", "info"],
    order=10,
    result_type="metricSummary",
)
def project_info(payload: dict[str, Any]) -> dict[str, str]:
    project_dir = unreal.Paths.project_dir() if hasattr(unreal, "Paths") else ""
    return {
        "projectName": unreal.SystemLibrary.get_project_name(),
        "projectDir": project_dir,
    }


@command(
    "editor.log",
    description="Write a message to the Unreal log.",
    permission="write",
    schema={
        "type": "object",
        "properties": {
            "message": {"type": "string", "maxLength": 1024},
            "dryRun": {
                "type": "boolean",
                "description": "Validate the command without writing to the Unreal log.",
                "default": False,
                "xDryRun": True,
            },
        },
        "required": ["message"],
        "additionalProperties": False,
    },
    supports_dry_run=True,
    category="Editor",
    icon="terminal",
    tags=["log", "debug"],
    order=20,
)
def editor_log(payload: dict[str, Any]) -> dict[str, Any]:
    message = str(payload.get("message", "Hello from Unreal Editor WebUI"))
    if bool(payload.get("dryRun", False)):
        return {
            "logged": message,
            "dryRun": True,
        }

    unreal.log(message)
    return {
        "logged": message,
        "dryRun": False,
    }


@command(
    "editor.selectedAssets",
    description="Return assets currently selected in the Content Browser.",
    permission="read",
    category="Editor",
    icon="mouse-pointer",
    tags=["asset", "selection"],
    order=30,
    result_type="assetTable",
)
def selected_assets(payload: dict[str, Any]) -> dict[str, Any]:
    selected = unreal.EditorUtilityLibrary.get_selected_assets()
    assets = [_asset_to_dict(asset) for asset in selected]
    return {
        "count": len(assets),
        "assets": assets,
    }
