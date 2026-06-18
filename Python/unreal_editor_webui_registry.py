import copy
import json
import traceback
from typing import Any, Callable

import unreal

CommandHandler = Callable[[dict[str, Any]], Any]
COMMANDS: dict[str, CommandHandler] = {}
COMMAND_METADATA: dict[str, dict[str, Any]] = {}
DEFAULT_PERMISSION_POLICY = {
    "allowedCommand": "",
    "allowedPermission": "",
}


def command(
    name: str,
    *,
    description: str = "",
    permission: str = "read",
    schema: dict[str, Any] | None = None,
    supports_dry_run: bool = False,
    execution_thread: str = "editor_game_thread",
    cancellation_mode: str = "queued_only",
    timeout_policy: str = "none",
) -> Callable[[CommandHandler], CommandHandler]:
    """Register a Python command that can be called from the editor Web UI."""

    def decorator(handler: CommandHandler) -> CommandHandler:
        COMMANDS[name] = handler
        COMMAND_METADATA[name] = {
            "name": name,
            "description": description,
            "permission": permission,
            "schema": schema or {"type": "object", "properties": {}},
            "supportsDryRun": supports_dry_run,
            "execution": {
                "thread": execution_thread,
                "cancellationMode": cancellation_mode,
                "timeoutPolicy": timeout_policy,
            },
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


def _format_schema_path(path: list[str]) -> str:
    return ".".join(path)


def _get_schema_number(schema: dict[str, Any], key: str) -> int | float | None:
    value = schema.get(key)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    return None


def _get_schema_integer(schema: dict[str, Any], key: str) -> int | None:
    value = schema.get(key)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def _expected_types(expected_type: Any) -> list[str]:
    if isinstance(expected_type, str):
        return [expected_type]
    if isinstance(expected_type, list):
        return [item for item in expected_type if isinstance(item, str)]
    return []


def _type_label(expected_types: list[str]) -> str:
    if len(expected_types) == 1:
        return expected_types[0]
    return "one of: " + ", ".join(expected_types)


def _apply_schema_defaults(value: Any, schema: dict[str, Any]) -> Any:
    if not isinstance(schema, dict):
        return value

    schema_types = set(_expected_types(schema.get("type")))
    if "object" in schema_types and isinstance(value, dict):
        result = dict(value)
        properties = schema.get("properties", {})
        if isinstance(properties, dict):
            for key, property_schema in properties.items():
                if not isinstance(property_schema, dict):
                    continue

                if key not in result and "default" in property_schema:
                    result[key] = copy.deepcopy(property_schema["default"])

                if key in result:
                    result[key] = _apply_schema_defaults(result[key], property_schema)
        return result

    if "array" in schema_types and isinstance(value, list):
        items_schema = schema.get("items")
        if isinstance(items_schema, dict):
            return [_apply_schema_defaults(item, items_schema) for item in value]

    return value


def _validate_schema_value(value: Any, schema: dict[str, Any], path: list[str]) -> list[str]:
    errors: list[str] = []
    field_path = _format_schema_path(path)

    expected_types = _expected_types(schema.get("type"))
    if expected_types and not any(_validate_type(value, expected_type) for expected_type in expected_types):
        errors.append(f"Field '{field_path}' must be {_type_label(expected_types)}.")
        return errors

    enum_values = schema.get("enum")
    if enum_values is not None and value not in enum_values:
        errors.append(f"Field '{field_path}' must be one of: {enum_values}")

    if isinstance(value, str):
        min_length = _get_schema_integer(schema, "minLength")
        max_length = _get_schema_integer(schema, "maxLength")
        if min_length is not None and len(value) < min_length:
            errors.append(f"Field '{field_path}' must be at least {min_length} characters.")
        if max_length is not None and len(value) > max_length:
            errors.append(f"Field '{field_path}' must be at most {max_length} characters.")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = _get_schema_number(schema, "minimum")
        maximum = _get_schema_number(schema, "maximum")
        exclusive_minimum = _get_schema_number(schema, "exclusiveMinimum")
        exclusive_maximum = _get_schema_number(schema, "exclusiveMaximum")
        if minimum is not None and value < minimum:
            errors.append(f"Field '{field_path}' must be greater than or equal to {minimum}.")
        if maximum is not None and value > maximum:
            errors.append(f"Field '{field_path}' must be less than or equal to {maximum}.")
        if exclusive_minimum is not None and value <= exclusive_minimum:
            errors.append(f"Field '{field_path}' must be greater than {exclusive_minimum}.")
        if exclusive_maximum is not None and value >= exclusive_maximum:
            errors.append(f"Field '{field_path}' must be less than {exclusive_maximum}.")

    if isinstance(value, list):
        min_items = _get_schema_integer(schema, "minItems")
        max_items = _get_schema_integer(schema, "maxItems")
        if min_items is not None and len(value) < min_items:
            errors.append(f"Field '{field_path}' must include at least {min_items} items.")
        if max_items is not None and len(value) > max_items:
            errors.append(f"Field '{field_path}' must include at most {max_items} items.")

        items_schema = schema.get("items")
        if isinstance(items_schema, dict):
            for index, item in enumerate(value):
                errors.extend(_validate_schema_value(item, items_schema, [*path[:-1], f"{path[-1]}[{index}]"]))

    if isinstance(value, dict):
        errors.extend(_validate_object_payload(value, schema, path))

    return errors


def _validate_object_payload(payload: dict[str, Any], schema: dict[str, Any], path: list[str]) -> list[str]:
    errors: list[str] = []
    base_path = _format_schema_path(path)

    properties = schema.get("properties", {})
    if not isinstance(properties, dict):
        properties = {}

    required = schema.get("required", [])
    if not isinstance(required, list):
        required = []
    additional_properties = schema.get("additionalProperties", True)

    for key in required:
        if isinstance(key, str) and key not in payload:
            missing_path = ".".join([base_path, key]) if base_path else key
            errors.append(f"Missing required field: {missing_path}")

    if additional_properties is False:
        for key in payload:
            if key not in properties:
                unexpected_path = ".".join([base_path, key]) if base_path else key
                errors.append(f"Unexpected field: {unexpected_path}")

    for key, value in payload.items():
        property_schema = properties.get(key)
        child_path = [*path, key] if path else [key]
        if isinstance(property_schema, dict):
            errors.extend(_validate_schema_value(value, property_schema, child_path))
            continue

        if isinstance(additional_properties, dict):
            errors.extend(_validate_schema_value(value, additional_properties, child_path))

    return errors


def _validate_payload(payload: dict[str, Any], schema: dict[str, Any]) -> list[str]:
    if schema.get("type", "object") != "object":
        return ["Command payload schema must be an object schema."]

    return _validate_object_payload(payload, schema, [])


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


def _permission_policy(policy: dict[str, Any] | None) -> dict[str, str]:
    merged = dict(DEFAULT_PERMISSION_POLICY)
    if isinstance(policy, dict):
        merged["allowedCommand"] = str(policy.get("allowedCommand", merged["allowedCommand"]))
        merged["allowedPermission"] = str(policy.get("allowedPermission", merged["allowedPermission"])).lower()
    return merged


def _permission_allowed(command_name: str, permission: str, policy: dict[str, str]) -> bool:
    normalized = permission.lower()
    if normalized == "read":
        return True
    return policy["allowedCommand"] == command_name and policy["allowedPermission"] == normalized


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
                "execution": metadata.get("execution", {}),
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
        if not _permission_allowed(command_name, permission, policy):
            return _error(
                request_id,
                "permission_denied",
                f'Command "{command_name}" requires {permission} permission.',
            )

        schema = metadata.get("schema", {})
        payload = _apply_schema_defaults(payload, schema)
        validation_errors = _validate_payload(payload, schema)
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
                "minLength": 1,
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
                "minimum": 1,
                "maximum": 500,
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
