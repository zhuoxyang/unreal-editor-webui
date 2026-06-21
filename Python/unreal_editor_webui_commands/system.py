from __future__ import annotations

from typing import Any

from unreal_editor_webui_registry import COMMAND_LOAD_ERRORS, COMMAND_METADATA, command


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
        "metadataVersion": 1,
        "commands": commands,
        "loadErrors": list(COMMAND_LOAD_ERRORS),
    }


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
