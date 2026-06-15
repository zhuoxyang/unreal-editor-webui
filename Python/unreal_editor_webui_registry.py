import json
import traceback
from typing import Any, Callable

import unreal

CommandHandler = Callable[[dict[str, Any]], Any]
COMMANDS: dict[str, CommandHandler] = {}


def command(name: str) -> Callable[[CommandHandler], CommandHandler]:
    """Register a Python command that can be called from the editor Web UI."""

    def decorator(handler: CommandHandler) -> CommandHandler:
        COMMANDS[name] = handler
        return handler

    return decorator


def _success(request_id: str | None, result: Any) -> str:
    return json.dumps(
        {
            "id": request_id,
            "ok": True,
            "result": result,
        },
        ensure_ascii=False,
    )


def _error(request_id: str | None, code: str, message: str, **extra: Any) -> str:
    error = {
        "code": code,
        "message": message,
    }
    error.update(extra)

    return json.dumps(
        {
            "id": request_id,
            "ok": False,
            "error": error,
        },
        ensure_ascii=False,
    )


def execute_command(request_json: str) -> str:
    request_id = None

    try:
        request = json.loads(request_json)
        if not isinstance(request, dict):
            return _error(None, "invalid_request", "Request must be a JSON object.")

        request_id = request.get("id")
        command_name = request.get("command")
        payload = request.get("payload", {})

        if not isinstance(command_name, str) or not command_name:
            return _error(request_id, "invalid_command", "Command must be a non-empty string.")

        if not isinstance(payload, dict):
            return _error(request_id, "invalid_payload", "Payload must be a JSON object.")

        handler = COMMANDS.get(command_name)
        if handler is None:
            return _error(request_id, "unknown_command", f"Unknown command: {command_name}")

        return _success(request_id, handler(payload))

    except json.JSONDecodeError as exc:
        return _error(request_id, "invalid_json", str(exc))
    except Exception as exc:
        return _error(
            request_id,
            "handler_exception",
            str(exc),
            traceback=traceback.format_exc(),
        )


@command("system.ping")
def ping(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "message": "pong",
        "echo": payload,
    }


@command("editor.projectInfo")
def project_info(payload: dict[str, Any]) -> dict[str, str]:
    project_dir = unreal.Paths.project_dir() if hasattr(unreal, "Paths") else ""
    return {
        "projectName": unreal.SystemLibrary.get_project_name(),
        "projectDir": project_dir,
    }


@command("editor.log")
def editor_log(payload: dict[str, Any]) -> dict[str, str]:
    message = str(payload.get("message", "Hello from Unreal Editor WebUI"))
    unreal.log(message)
    return {
        "logged": message,
    }


@command("demo.run")
def demo_run(payload: dict[str, Any]) -> dict[str, str]:
    from unreal_editor_webui_demo import run_demo_command

    project_name = run_demo_command()
    return {
        "projectName": project_name,
    }
