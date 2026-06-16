import json
import traceback
from typing import Any, Callable

import unreal

CommandHandler = Callable[[dict[str, Any]], Any]
COMMANDS: dict[str, CommandHandler] = {}
COMMAND_METADATA: dict[str, dict[str, Any]] = {}


def command(
    name: str,
    *,
    description: str = "",
    permission: str = "read",
    schema: dict[str, Any] | None = None,
) -> Callable[[CommandHandler], CommandHandler]:
    """Register a Python command that can be called from the editor Web UI."""

    def decorator(handler: CommandHandler) -> CommandHandler:
        COMMANDS[name] = handler
        COMMAND_METADATA[name] = {
            "name": name,
            "description": description,
            "permission": permission,
            "schema": schema or {"type": "object", "properties": {}},
        }
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


def _validate_type(value: Any, expected_type: str) -> bool:
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected_type == "boolean":
        return isinstance(value, bool)
    if expected_type == "null":
        return value is None
    return True


def _validate_payload(payload: dict[str, Any], schema: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    if schema.get("type", "object") != "object":
        return ["Command payload schema must be an object schema."]

    properties = schema.get("properties", {})
    required = schema.get("required", [])
    additional_properties = schema.get("additionalProperties", True)

    for key in required:
        if key not in payload:
            errors.append(f"Missing required field: {key}")

    if additional_properties is False:
        for key in payload:
            if key not in properties:
                errors.append(f"Unexpected field: {key}")

    for key, value in payload.items():
        property_schema = properties.get(key)
        if not isinstance(property_schema, dict):
            continue

        expected_type = property_schema.get("type")
        if expected_type and not _validate_type(value, expected_type):
            errors.append(f"Field '{key}' must be {expected_type}.")

        enum_values = property_schema.get("enum")
        if enum_values is not None and value not in enum_values:
            errors.append(f"Field '{key}' must be one of: {enum_values}")

        max_length = property_schema.get("maxLength")
        if isinstance(max_length, int) and isinstance(value, str) and len(value) > max_length:
            errors.append(f"Field '{key}' must be at most {max_length} characters.")

    return errors


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

        metadata = COMMAND_METADATA.get(command_name, {})
        validation_errors = _validate_payload(payload, metadata.get("schema", {}))
        if validation_errors:
            return _error(
                request_id,
                "invalid_payload",
                "Payload failed schema validation.",
                details=validation_errors,
            )

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


@command(
    "system.commands",
    description="List commands exposed by the Python registry.",
    permission="read",
)
def list_commands(payload: dict[str, Any]) -> dict[str, Any]:
    commands = [COMMAND_METADATA[name] for name in sorted(COMMAND_METADATA)]
    return {
        "commands": commands,
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
)
def ping(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "message": "pong",
        "echo": payload,
    }


@command(
    "editor.projectInfo",
    description="Return basic project information from the Unreal Editor.",
    permission="read",
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
        },
        "required": ["message"],
        "additionalProperties": False,
    },
)
def editor_log(payload: dict[str, Any]) -> dict[str, str]:
    message = str(payload.get("message", "Hello from Unreal Editor WebUI"))
    unreal.log(message)
    return {
        "logged": message,
    }


@command(
    "demo.run",
    description="Run the bundled Python demo command.",
    permission="read",
)
def demo_run(payload: dict[str, Any]) -> dict[str, str]:
    from unreal_editor_webui_demo import run_demo_command

    project_name = run_demo_command()
    return {
        "projectName": project_name,
    }
