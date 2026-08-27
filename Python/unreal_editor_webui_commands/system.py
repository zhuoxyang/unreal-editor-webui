from __future__ import annotations

from typing import Any

from unreal_editor_webui_sdk import command
from unreal_editor_webui_registry import (
    COMMAND_LOAD_ERRORS,
    COMMAND_METADATA,
    METADATA_VERSION,
    _get_tool_pack_status,
)


@command(
    "system.commands",
    description="List commands exposed by the Python registry.",
    permission="read",
    category="System",
    icon="list",
    tags=["metadata", "registry"],
    order=0,
    result_type="commandList",
)
def list_commands(payload: dict[str, Any]) -> dict[str, Any]:
    commands = [COMMAND_METADATA[name] for name in sorted(COMMAND_METADATA)]
    return {
        "metadataVersion": METADATA_VERSION,
        "commands": commands,
        "loadErrors": list(COMMAND_LOAD_ERRORS),
    }


@command(
    "system.toolPacks",
    description="List bounded status summaries for discovered Tool Packs.",
    permission="read",
    category="System",
    icon="package",
    tags=["metadata", "registry", "tool-packs"],
    order=1,
)
def list_tool_packs(payload: dict[str, Any]) -> dict[str, Any]:
    return _get_tool_pack_status()


@command(
    "system.ping",
    description="Round-trip smoke test for the command bridge.",
    permission="read",
    schema={
        "type": "object",
        "properties": {
            "source": {"type": "string", "maxLength": 64},
            "at": {"type": "number"},
        },
        "additionalProperties": True,
    },
    category="System",
    icon="activity",
    tags=["smoke", "debug"],
    order=10,
)
def ping(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "message": "pong",
        "echo": payload,
    }
