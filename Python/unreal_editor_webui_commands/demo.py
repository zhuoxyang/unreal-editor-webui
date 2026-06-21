from __future__ import annotations

from typing import Any

from unreal_editor_webui_registry import command


@command(
    "demo.run",
    description="Run the bundled Python demo command.",
    permission="read",
    category="Demo",
    icon="play",
    tags=["demo", "smoke"],
    order=10,
)
def demo_run(payload: dict[str, Any]) -> dict[str, str]:
    from unreal_editor_webui_demo import run_demo_command

    project_name = run_demo_command()
    return {
        "projectName": project_name,
    }


@command(
    "demo.longRun",
    description="Run a cooperative demo task over multiple editor ticks.",
    permission="read",
    schema={
        "type": "object",
        "properties": {
            "steps": {
                "type": "integer",
                "description": "Number of editor ticks used to complete the demo.",
                "default": 10,
                "minimum": 1,
                "maximum": 100,
            },
        },
        "additionalProperties": False,
    },
    execution_thread="editor_tick",
    cancellation_mode="cooperative",
    timeout_policy="seconds:10",
    category="Demo",
    icon="timer",
    tags=["demo", "task", "cooperative"],
    order=20,
)
def long_run_demo(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "message": "Use startcommand for cooperative progress; executecommand validates the payload only.",
        "steps": int(payload.get("steps", 10)),
    }
