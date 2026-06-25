from __future__ import annotations

import copy
import importlib
import json
import pkgutil
import traceback
from typing import Any, Callable

import unreal

CommandHandler = Callable[[dict[str, Any]], Any]
COMMANDS: dict[str, CommandHandler] = {}
COMMAND_METADATA: dict[str, dict[str, Any]] = {}
COMMAND_LOAD_ERRORS: list[dict[str, str]] = []
METADATA_VERSION = 1
SUPPORTED_PERMISSIONS = {"read", "write", "destructive"}
SUPPORTED_SCHEMA_TYPES = {"object", "array", "string", "integer", "number", "boolean", "null"}
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
    category: str = "",
    icon: str = "",
    tags: list[str] | None = None,
    order: int = 100,
    supported_asset_types: list[str] | None = None,
    ui: dict[str, Any] | None = None,
    result_type: str = "json",
    warnings: list[str] | None = None,
) -> Callable[[CommandHandler], CommandHandler]:
    """Register a Python command that can be called from the editor Web UI."""

    normalized_name = name.strip() if isinstance(name, str) else ""
    normalized_permission = permission.lower().strip() if isinstance(permission, str) else ""
    normalized_schema = schema or {"type": "object", "properties": {}}

    if not normalized_name:
        raise ValueError("Command name must be a non-empty string.")
    if normalized_permission not in SUPPORTED_PERMISSIONS:
        raise ValueError(
            f'Command "{normalized_name}" uses unsupported permission "{permission}". '
            f"Expected one of: {sorted(SUPPORTED_PERMISSIONS)}"
        )
    if normalized_name in COMMANDS:
        raise ValueError(f'Command "{normalized_name}" is already registered.')
    _validate_command_schema(normalized_name, normalized_schema)

    def decorator(handler: CommandHandler) -> CommandHandler:
        COMMANDS[normalized_name] = handler
        COMMAND_METADATA[normalized_name] = {
            "metadataVersion": METADATA_VERSION,
            "name": normalized_name,
            "description": description,
            "permission": normalized_permission,
            "schema": normalized_schema,
            "supportsDryRun": supports_dry_run,
            "category": category,
            "icon": icon,
            "tags": tags or [],
            "order": order,
            "supportedAssetTypes": supported_asset_types or [],
            "ui": ui or {},
            "resultType": result_type,
            "warnings": warnings or [],
            "execution": {
                "thread": execution_thread,
                "cancellationMode": cancellation_mode,
                "timeoutPolicy": timeout_policy,
            },
        }
        return handler

    return decorator


def load_command_modules(package_name: str = "unreal_editor_webui_commands") -> None:
    COMMAND_LOAD_ERRORS.clear()

    try:
        package = importlib.import_module(package_name)
    except Exception as exc:
        COMMAND_LOAD_ERRORS.append(
            {
                "module": package_name,
                "error": str(exc),
            }
        )
        return

    package_paths = getattr(package, "__path__", None)
    if package_paths is None:
        COMMAND_LOAD_ERRORS.append(
            {
                "module": package_name,
                "error": "Command package does not expose __path__.",
            }
        )
        return

    for module_info in sorted(pkgutil.iter_modules(package_paths), key=lambda item: item.name):
        module_name = f"{package_name}.{module_info.name}"
        try:
            importlib.import_module(module_name)
        except Exception as exc:
            COMMAND_LOAD_ERRORS.append(
                {
                    "module": module_name,
                    "error": str(exc),
                }
            )


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
    return False


def _validate_command_schema(command_name: str, schema: Any) -> None:
    def validate_node(node: Any, path: str) -> None:
        if not isinstance(node, dict):
            raise ValueError(f'Command "{command_name}" schema at {path} must be an object.')

        declared_type = node.get("type")
        declared_types = _expected_types(declared_type)
        if declared_type is not None and not declared_types:
            raise ValueError(f'Command "{command_name}" schema at {path} has an invalid type declaration.')

        unsupported_types = [item for item in declared_types if item not in SUPPORTED_SCHEMA_TYPES]
        if unsupported_types:
            raise ValueError(
                f'Command "{command_name}" schema at {path} uses unsupported type(s): '
                f'{", ".join(unsupported_types)}.'
            )

        properties = node.get("properties")
        if properties is not None:
            if not isinstance(properties, dict):
                raise ValueError(f'Command "{command_name}" schema properties at {path} must be an object.')
            for property_name, property_schema in properties.items():
                if not isinstance(property_name, str) or not property_name:
                    raise ValueError(f'Command "{command_name}" schema at {path} has an invalid property name.')
                validate_node(property_schema, f"{path}.{property_name}")

        items = node.get("items")
        if items is not None:
            validate_node(items, f"{path}[]")

        required = node.get("required")
        if required is not None and (
            not isinstance(required, list) or any(not isinstance(item, str) or not item for item in required)
        ):
            raise ValueError(f'Command "{command_name}" schema required list at {path} is invalid.')

        enum_values = node.get("enum")
        if enum_values is not None and not isinstance(enum_values, list):
            raise ValueError(f'Command "{command_name}" schema enum at {path} must be an array.')

    validate_node(schema, "payload")
    if schema.get("type", "object") != "object":
        raise ValueError(f'Command "{command_name}" payload schema must have type "object".')


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
    if normalized not in SUPPORTED_PERMISSIONS:
        return False
    if normalized == "read":
        return True
    return policy["allowedCommand"] == command_name and policy["allowedPermission"] == normalized


def _prepare_command_payload(
    request_id: str | None,
    command_name: str,
    payload: Any,
    schema: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(payload, dict):
        return None, _error(request_id, "invalid_payload", "Payload must be a JSON object.")

    normalized_payload = _apply_schema_defaults(payload, schema)
    validation_errors = _validate_payload(normalized_payload, schema)
    if validation_errors:
        return None, _error(
            request_id,
            "invalid_payload",
            "Payload failed schema validation.",
            details=validation_errors,
        )

    return normalized_payload, None


def inspect_command(request_json: str) -> str:
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

        metadata = COMMAND_METADATA.get(command_name)
        if metadata is None:
            return _error(request_id, "unknown_command", f"Unknown command: {command_name}")

        schema = metadata.get("schema", {})
        normalized_payload, payload_error = _prepare_command_payload(request_id, command_name, payload, schema)
        if payload_error is not None:
            return payload_error

        return _success(
            request_id,
            {
                "command": command_name,
                "permission": str(metadata.get("permission", "read")),
                "execution": metadata.get("execution", {}),
                "payloadValid": True,
                "normalizedPayload": normalized_payload,
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
        normalized_payload, payload_error = _prepare_command_payload(request_id, command_name, payload, schema)
        if payload_error is not None:
            return payload_error

        return _success(request_id, handler(normalized_payload))

    except json.JSONDecodeError as exc:
        return _error(request_id, "invalid_json", str(exc))
    except Exception as exc:
        _log_exception("Unreal Editor WebUI command handler failed.")
        return _error(
            request_id,
            "handler_exception",
            str(exc),
        )


load_command_modules()
