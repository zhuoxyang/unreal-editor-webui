import json
import traceback
from typing import Any, Callable

import unreal

CommandHandler = Callable[[dict[str, Any]], Any]
COMMANDS: dict[str, CommandHandler] = {}
COMMAND_METADATA: dict[str, dict[str, Any]] = {}
DEFAULT_PERMISSION_POLICY = {
    "allowWriteCommands": False,
    "allowDestructiveCommands": False,
}


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


def _log_exception(prefix: str) -> None:
    traceback_text = traceback.format_exc()
    message = f"{prefix}\n{traceback_text}"
    log_error = getattr(unreal, "log_error", None)
    if callable(log_error):
        log_error(message)
    else:
        unreal.log(message)


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


def _asset_to_dict(asset: Any) -> dict[str, str]:
    asset_class = asset.get_class() if hasattr(asset, "get_class") else None
    return {
        "name": asset.get_name() if hasattr(asset, "get_name") else str(asset),
        "path": asset.get_path_name() if hasattr(asset, "get_path_name") else "",
        "className": asset_class.get_name() if asset_class and hasattr(asset_class, "get_name") else "",
    }


def _asset_data_to_dict(asset_data: Any) -> dict[str, str]:
    return {
        "assetName": str(getattr(asset_data, "asset_name", "")),
        "packageName": str(getattr(asset_data, "package_name", "")),
        "packagePath": str(getattr(asset_data, "package_path", "")),
        "objectPath": str(getattr(asset_data, "object_path", "")),
        "assetClass": str(getattr(asset_data, "asset_class_path", getattr(asset_data, "asset_class", ""))),
    }


def _permission_policy(policy: dict[str, Any] | None) -> dict[str, bool]:
    merged = dict(DEFAULT_PERMISSION_POLICY)
    if isinstance(policy, dict):
        merged["allowWriteCommands"] = bool(policy.get("allowWriteCommands", merged["allowWriteCommands"]))
        merged["allowDestructiveCommands"] = bool(
            policy.get("allowDestructiveCommands", merged["allowDestructiveCommands"])
        )
    return merged


def _permission_allowed(permission: str, policy: dict[str, bool]) -> bool:
    normalized = permission.lower()
    if normalized == "read":
        return True
    if normalized == "write":
        return policy["allowWriteCommands"]
    if normalized == "destructive":
        return policy["allowDestructiveCommands"]
    return False


def inspect_command(request_json: str) -> str:
    request_id = None

    try:
        request = json.loads(request_json)
        if not isinstance(request, dict):
            return _error(None, "invalid_request", "Request must be a JSON object.")

        request_id = request.get("id")
        command_name = request.get("command")

        if not isinstance(command_name, str) or not command_name:
            return _error(request_id, "invalid_command", "Command must be a non-empty string.")

        metadata = COMMAND_METADATA.get(command_name)
        if metadata is None:
            return _error(request_id, "unknown_command", f"Unknown command: {command_name}")

        return _success(
            request_id,
            {
                "command": command_name,
                "permission": str(metadata.get("permission", "read")),
            },
        )

    except json.JSONDecodeError as exc:
        return _error(request_id, "invalid_json", str(exc))
    except Exception as exc:
        _log_exception("Unreal Editor WebUI command inspection failed.")
        return _error(
            request_id,
            "handler_exception",
            str(exc),
        )


def execute_command(request_json: str, permission_policy: dict[str, Any] | None = None) -> str:
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
        permission = str(metadata.get("permission", "read"))
        policy = _permission_policy(permission_policy)
        if not _permission_allowed(permission, policy):
            return _error(
                request_id,
                "permission_denied",
                f'Command "{command_name}" requires {permission} permission.',
            )

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
        _log_exception("Unreal Editor WebUI command handler failed.")
        return _error(
            request_id,
            "handler_exception",
            str(exc),
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
    "editor.selectedAssets",
    description="Return assets currently selected in the Content Browser.",
    permission="read",
)
def selected_assets(payload: dict[str, Any]) -> dict[str, Any]:
    selected = unreal.EditorUtilityLibrary.get_selected_assets()
    assets = [_asset_to_dict(asset) for asset in selected]
    return {
        "count": len(assets),
        "assets": assets,
    }


@command(
    "asset.listByPath",
    description="List assets under a content path using the Asset Registry.",
    permission="read",
    schema={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Content path, for example /Game",
                "maxLength": 512,
                "default": "/Game",
            },
            "recursive": {
                "type": "boolean",
                "description": "Include child folders.",
                "default": True,
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of assets to return.",
                "default": 50,
            },
        },
        "required": ["path"],
        "additionalProperties": False,
    },
)
def list_assets_by_path(payload: dict[str, Any]) -> dict[str, Any]:
    path = str(payload.get("path", "/Game"))
    recursive = bool(payload.get("recursive", True))
    limit = int(payload.get("limit", 50))
    limit = max(1, min(limit, 500))

    asset_registry = unreal.AssetRegistryHelpers.get_asset_registry()
    asset_data_items = asset_registry.get_assets_by_path(path, recursive)
    assets = [_asset_data_to_dict(asset_data) for asset_data in asset_data_items[:limit]]

    return {
        "path": path,
        "recursive": recursive,
        "count": len(assets),
        "truncated": len(asset_data_items) > limit,
        "assets": assets,
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
