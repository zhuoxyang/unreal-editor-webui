from __future__ import annotations

from typing import Any

from unreal_editor_webui_sdk import command


@command(
    "fixture.asset.echo",
    description="Echo a value through the external asset Tool Pack fixture.",
    permission="read",
    schema={
        "type": "object",
        "properties": {
            "value": {"type": "string", "default": "asset-fixture"},
        },
        "additionalProperties": False,
    },
    category="Fixtures",
    tags=["fixture", "tool-pack"],
)
def echo(payload: dict[str, Any]) -> dict[str, str]:
    return {
        "toolPack": "asset",
        "value": str(payload.get("value", "asset-fixture")),
    }
