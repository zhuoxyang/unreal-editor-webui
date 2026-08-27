from __future__ import annotations

from typing import Any

import unreal

from unreal_editor_webui_sdk import command


@command(
    "example.assets.selectionSummary",
    description="Summarize the assets currently selected in the Content Browser.",
    permission="read",
    category="Example Asset Tools",
    icon="list",
    tags=["example", "assets", "selection"],
    result_type="json",
)
def selection_summary(payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    selected_assets = unreal.EditorUtilityLibrary.get_selected_assets()
    return {
        "selectedCount": len(selected_assets),
        "assets": [
            {
                "name": asset.get_name(),
                "path": asset.get_path_name(),
            }
            for asset in selected_assets
        ],
    }
