from __future__ import annotations

import copy
import importlib
import inspect
import json
import math
import pkgutil
import re
import sys
import traceback
from dataclasses import dataclass
from types import GeneratorType
from typing import Any, Callable

import unreal

CommandHandler = Callable[[dict[str, Any]], Any]
COMMANDS: dict[str, CommandHandler] = {}
COMMAND_METADATA: dict[str, dict[str, Any]] = {}
COMMAND_LOAD_ERRORS: list[dict[str, str]] = []
COOPERATIVE_JOBS: dict[str, "CooperativeJob"] = {}
METADATA_VERSION = 1
SUPPORTED_PERMISSIONS = {"read", "write", "destructive"}
SUPPORTED_SCHEMA_TYPES = {"object", "array", "string", "integer", "number", "boolean"}
MAX_COMMAND_SCHEMA_DEPTH = 16
ROOT_SCHEMA_KEYWORDS = {"type", "properties", "required", "additionalProperties"}
COMMON_PROPERTY_SCHEMA_KEYWORDS = {"type", "description", "default", "enum"}
TYPE_SCHEMA_KEYWORDS = {
    "object": {"properties", "required", "additionalProperties"},
    "array": {"items", "minItems", "maxItems"},
    "string": {"minLength", "maxLength"},
    "integer": {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"},
    "number": {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"},
    "boolean": set(),
}
SUPPORTED_EXECUTION_THREADS = {"editor_game_thread", "editor_tick"}
SUPPORTED_CANCELLATION_MODES = {"queued_only", "cooperative"}
MAX_REQUEST_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_JSON_DEPTH = 32
MAX_JSON_NODES = 10_000
MAX_COOPERATIVE_JOBS = 64
STRICT_DECIMAL_PATTERN = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")
DEFAULT_PERMISSION_POLICY = {
    "allowedCommand": "",
    "allowedPermission": "",
}


class CommandExecutionError(RuntimeError):
    """A command failure that can be returned as a stable, structured envelope."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: list[str] | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details
        self.data = data


def _command_error_extra(error: CommandExecutionError) -> dict[str, Any]:
    extra: dict[str, Any] = {}
    if error.details is not None:
        extra["details"] = error.details
    if error.data is not None:
        extra["data"] = error.data
    return extra


class ProtocolValidationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class CooperativeJob:
    request_id: str | None
    command_name: str
    iterator: GeneratorType


def _validate_raw_json_nesting(document: str) -> None:
    depth = 0
    in_string = False
    escaped = False
    for character in document:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue

        if character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            if depth > MAX_JSON_DEPTH:
                raise ProtocolValidationError(
                    "json_too_complex",
                    f"JSON nesting exceeds the maximum depth of {MAX_JSON_DEPTH}.",
                )
        elif character in "]}":
            depth = max(0, depth - 1)


def _validate_json_nodes(value: Any) -> None:
    nodes = 0
    stack = [value]
    while stack:
        current = stack.pop()
        nodes += 1
        if nodes > MAX_JSON_NODES:
            raise ProtocolValidationError(
                "json_too_complex",
                f"JSON contains more than {MAX_JSON_NODES} nodes.",
            )
        if isinstance(current, dict):
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def parse_json_document(document: str, *, max_bytes: int = MAX_REQUEST_BYTES) -> Any:
    if not isinstance(document, str):
        raise ProtocolValidationError("invalid_json", "JSON document must be a string.")
    if len(document.encode("utf-8")) > max_bytes:
        raise ProtocolValidationError(
            "request_too_large",
            f"JSON request exceeds the maximum size of {max_bytes} bytes.",
        )

    _validate_raw_json_nesting(document)
    try:
        value = json.loads(document)
    except RecursionError as exc:
        raise ProtocolValidationError(
            "json_too_complex",
            f"JSON nesting exceeds the maximum depth of {MAX_JSON_DEPTH}.",
        ) from exc
    _validate_json_nodes(value)
    return value


def _validated_request_id(request: dict[str, Any]) -> str | None:
    request_id = request.get("id")
    if request_id is not None and not isinstance(request_id, str):
        raise ProtocolValidationError(
            "invalid_request",
            "Request id must be a string or null.",
        )
    return request_id


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
    normalized_execution_thread = execution_thread.lower().strip() if isinstance(execution_thread, str) else ""
    normalized_cancellation_mode = cancellation_mode.lower().strip() if isinstance(cancellation_mode, str) else ""
    normalized_timeout_policy = timeout_policy.lower().strip() if isinstance(timeout_policy, str) else ""
    normalized_schema = (
        copy.deepcopy(schema)
        if schema is not None
        else {"type": "object", "properties": {}}
    )

    if not normalized_name:
        raise ValueError("Command name must be a non-empty string.")
    if normalized_permission not in SUPPORTED_PERMISSIONS:
        raise ValueError(
            f'Command "{normalized_name}" uses unsupported permission "{permission}". '
            f"Expected one of: {sorted(SUPPORTED_PERMISSIONS)}"
        )
    if normalized_name in COMMANDS:
        raise ValueError(f'Command "{normalized_name}" is already registered.')
    _validate_execution_metadata(
        normalized_name,
        normalized_execution_thread,
        normalized_cancellation_mode,
        normalized_timeout_policy,
    )
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
                "thread": normalized_execution_thread,
                "cancellationMode": normalized_cancellation_mode,
                "timeoutPolicy": normalized_timeout_policy,
            },
        }
        return handler

    return decorator


def _validate_execution_metadata(
    command_name: str,
    execution_thread: str,
    cancellation_mode: str,
    timeout_policy: str,
) -> None:
    if execution_thread not in SUPPORTED_EXECUTION_THREADS:
        raise ValueError(
            f'Command "{command_name}" uses unsupported execution thread "{execution_thread}". '
            f"Expected one of: {sorted(SUPPORTED_EXECUTION_THREADS)}"
        )
    if cancellation_mode not in SUPPORTED_CANCELLATION_MODES:
        raise ValueError(
            f'Command "{command_name}" uses unsupported cancellation mode "{cancellation_mode}". '
            f"Expected one of: {sorted(SUPPORTED_CANCELLATION_MODES)}"
        )

    if timeout_policy != "none" and not timeout_policy.startswith("seconds:"):
        raise ValueError(
            f'Command "{command_name}" uses unsupported timeout policy "{timeout_policy}". '
            'Expected "none" or "seconds:<positive number>".'
        )

    if timeout_policy != "none":
        seconds_text = timeout_policy.removeprefix("seconds:")
        if STRICT_DECIMAL_PATTERN.fullmatch(seconds_text) is None:
            raise ValueError(
                f'Command "{command_name}" uses invalid timeout policy "{timeout_policy}".'
            )
        try:
            seconds = float(seconds_text)
        except ValueError as exc:
            raise ValueError(
                f'Command "{command_name}" uses invalid timeout policy "{timeout_policy}".'
            ) from exc
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError(
                f'Command "{command_name}" timeout seconds must be a finite positive number.'
            )

    if execution_thread == "editor_game_thread" and cancellation_mode != "queued_only":
        raise ValueError(
            f'Command "{command_name}" must use queued_only cancellation on editor_game_thread.'
        )
    if execution_thread == "editor_game_thread" and timeout_policy != "none":
        raise ValueError(
            f'Command "{command_name}" must use timeout policy none on editor_game_thread.'
        )
    if execution_thread == "editor_tick" and cancellation_mode != "cooperative":
        raise ValueError(
            f'Command "{command_name}" must use cooperative cancellation on editor_tick.'
        )


def _import_command_module(module_name: str, package_name: str) -> Any:
    handlers_before = dict(COMMANDS)
    metadata_before = copy.deepcopy(COMMAND_METADATA)
    modules_before = set(sys.modules)
    try:
        return importlib.import_module(module_name)
    except Exception:
        COMMANDS.clear()
        COMMANDS.update(handlers_before)
        COMMAND_METADATA.clear()
        COMMAND_METADATA.update(metadata_before)
        for loaded_module in set(sys.modules).difference(modules_before):
            if loaded_module == package_name or loaded_module.startswith(f"{package_name}."):
                sys.modules.pop(loaded_module, None)
        raise


def load_command_modules(package_name: str = "unreal_editor_webui_commands") -> None:
    COMMAND_LOAD_ERRORS.clear()

    try:
        package = _import_command_module(package_name, package_name)
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
            _import_command_module(module_name, package_name)
        except Exception as exc:
            COMMAND_LOAD_ERRORS.append(
                {
                    "module": module_name,
                    "error": str(exc),
                }
            )


def _serialize_response(request_id: str | None, envelope: dict[str, Any]) -> str:
    try:
        response = json.dumps(envelope, ensure_ascii=False)
    except (RecursionError, TypeError, ValueError):
        response = json.dumps(
            {
                "id": request_id,
                "ok": False,
                "error": {
                    "code": "invalid_handler_result",
                    "message": "Command result could not be serialized as JSON.",
                },
            },
            ensure_ascii=False,
        )

    if len(response.encode("utf-8")) <= MAX_RESPONSE_BYTES:
        return response

    return json.dumps(
        {
            "id": request_id,
            "ok": False,
            "error": {
                "code": "response_too_large",
                "message": f"Command response exceeds the maximum size of {MAX_RESPONSE_BYTES} bytes.",
            },
        },
        ensure_ascii=False,
    )


def _success(request_id: str | None, result: Any) -> str:
    return _serialize_response(
        request_id,
        {
            "id": request_id,
            "ok": True,
            "result": result,
        },
    )


def _error(request_id: str | None, code: str, message: str, **extra: Any) -> str:
    error = {
        "code": code,
        "message": message,
    }
    error.update(extra)

    return _serialize_response(
        request_id,
        {
            "id": request_id,
            "ok": False,
            "error": error,
        },
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
        return (
            isinstance(value, int)
            and not isinstance(value, bool)
        ) or (
            isinstance(value, float)
            and math.isfinite(value)
            and value.is_integer()
        )
    if expected_type == "number":
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and (not isinstance(value, float) or math.isfinite(value))
        )
    if expected_type == "boolean":
        return isinstance(value, bool)
    return False


def _validate_command_schema(command_name: str, schema: Any) -> None:
    def fail(path: str, message: str) -> None:
        raise ValueError(f'Command "{command_name}" schema at {path} {message}')

    def validate_json_value(value: Any, path: str) -> None:
        node_count = 0
        stack = [(value, 0)]
        while stack:
            current, depth = stack.pop()
            node_count += 1
            if node_count > MAX_JSON_NODES:
                fail(path, f"contains more than {MAX_JSON_NODES} JSON nodes.")
            if depth > MAX_JSON_DEPTH:
                fail(path, f"exceeds the maximum JSON depth of {MAX_JSON_DEPTH}.")
            if current is None or isinstance(current, (str, bool, int)):
                continue
            if isinstance(current, float):
                if math.isfinite(current):
                    continue
                fail(path, "must contain only finite JSON numbers.")
            if isinstance(current, list):
                stack.extend((item, depth + 1) for item in current)
                continue
            if isinstance(current, dict):
                if any(not isinstance(key, str) for key in current):
                    fail(path, "must contain only string JSON object keys.")
                stack.extend((item, depth + 1) for item in current.values())
                continue
            fail(path, "must be JSON-compatible.")

    def validate_nonnegative_integer(node: dict[str, Any], key: str, path: str) -> int | None:
        if key not in node:
            return None
        value = node[key]
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            fail(f"{path}.{key}", "must be a non-negative integer.")
        return value

    def validate_finite_number(node: dict[str, Any], key: str, path: str) -> int | float | None:
        if key not in node:
            return None
        value = node[key]
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
        ):
            fail(f"{path}.{key}", "must be a finite number.")
        return value

    def validate_numeric_bounds(node: dict[str, Any], declared_type: str, path: str) -> None:
        minimum = validate_finite_number(node, "minimum", path)
        maximum = validate_finite_number(node, "maximum", path)
        exclusive_minimum = validate_finite_number(node, "exclusiveMinimum", path)
        exclusive_maximum = validate_finite_number(node, "exclusiveMaximum", path)

        lower_bounds = [
            (value, exclusive)
            for value, exclusive in ((minimum, False), (exclusive_minimum, True))
            if value is not None
        ]
        upper_bounds = [
            (value, exclusive)
            for value, exclusive in ((maximum, False), (exclusive_maximum, True))
            if value is not None
        ]
        if not lower_bounds or not upper_bounds:
            return

        lower_value = max(value for value, _ in lower_bounds)
        lower_exclusive = any(value == lower_value and exclusive for value, exclusive in lower_bounds)
        upper_value = min(value for value, _ in upper_bounds)
        upper_exclusive = any(value == upper_value and exclusive for value, exclusive in upper_bounds)
        if lower_value > upper_value or (
            lower_value == upper_value and (lower_exclusive or upper_exclusive)
        ):
            fail(path, "has contradictory numeric bounds.")

        if declared_type == "integer":
            first_integer = (
                math.floor(lower_value) + 1
                if lower_exclusive
                else math.ceil(lower_value)
            )
            last_integer = (
                math.ceil(upper_value) - 1
                if upper_exclusive
                else math.floor(upper_value)
            )
            if first_integer > last_integer:
                fail(path, "has numeric bounds that allow no integer value.")

    def validate_node(
        node: Any,
        path: str,
        depth: int,
        *,
        is_root: bool = False,
        is_direct_payload_property: bool = False,
    ) -> None:
        if not isinstance(node, dict):
            fail(path, "must be an object.")
        if depth > MAX_COMMAND_SCHEMA_DEPTH:
            fail(path, f"exceeds the supported depth of {MAX_COMMAND_SCHEMA_DEPTH}.")
        if any(not isinstance(key, str) or not key for key in node):
            fail(path, "has an invalid keyword name.")

        declared_type = node.get("type")
        if not isinstance(declared_type, str):
            fail(f"{path}.type", "must declare one supported string type; unions are not supported.")
        if declared_type not in SUPPORTED_SCHEMA_TYPES:
            fail(
                f"{path}.type",
                f'uses unsupported type "{declared_type}"; expected one of: {sorted(SUPPORTED_SCHEMA_TYPES)}.',
            )
        if is_root and declared_type != "object":
            fail(f"{path}.type", 'must be "object".')

        allowed_keywords = (
            ROOT_SCHEMA_KEYWORDS
            if is_root
            else COMMON_PROPERTY_SCHEMA_KEYWORDS | TYPE_SCHEMA_KEYWORDS[declared_type]
        )
        if is_direct_payload_property:
            allowed_keywords = allowed_keywords | {"xDryRun"}
        unknown_keywords = sorted(set(node).difference(allowed_keywords))
        if unknown_keywords:
            fail(path, f"uses unsupported keyword(s): {', '.join(unknown_keywords)}.")

        description = node.get("description")
        if description is not None and not isinstance(description, str):
            fail(f"{path}.description", "must be a string.")

        if "xDryRun" in node:
            if not isinstance(node["xDryRun"], bool):
                fail(f"{path}.xDryRun", "must be a boolean.")
            if declared_type != "boolean":
                fail(f"{path}.xDryRun", 'is only supported for type "boolean".')

        if declared_type == "object":
            properties = node.get("properties", {})
            if not isinstance(properties, dict):
                fail(f"{path}.properties", "must be an object.")
            for property_name, property_schema in properties.items():
                if not isinstance(property_name, str) or not property_name:
                    fail(f"{path}.properties", "has an invalid property name.")
                validate_node(
                    property_schema,
                    f"{path}.{property_name}",
                    depth + 1,
                    is_direct_payload_property=is_root,
                )

            required = node.get("required", [])
            if not isinstance(required, list) or any(
                not isinstance(item, str) or not item for item in required
            ):
                fail(f"{path}.required", "must be an array of non-empty strings.")
            if len(set(required)) != len(required):
                fail(f"{path}.required", "must not contain duplicate property names.")
            unknown_required = sorted(set(required).difference(properties))
            if unknown_required:
                fail(
                    f"{path}.required",
                    f"references unknown properties: {', '.join(unknown_required)}.",
                )

            additional_properties = node.get("additionalProperties", True)
            if not isinstance(additional_properties, bool):
                fail(f"{path}.additionalProperties", "must be a boolean.")

        if declared_type == "array":
            if "items" not in node:
                fail(f"{path}.items", "is required for array schemas.")
            validate_node(node["items"], f"{path}[]", depth + 1)
            min_items = validate_nonnegative_integer(node, "minItems", path)
            max_items = validate_nonnegative_integer(node, "maxItems", path)
            if min_items is not None and max_items is not None and min_items > max_items:
                fail(path, "has minItems greater than maxItems.")

        if declared_type == "string":
            min_length = validate_nonnegative_integer(node, "minLength", path)
            max_length = validate_nonnegative_integer(node, "maxLength", path)
            if min_length is not None and max_length is not None and min_length > max_length:
                fail(path, "has minLength greater than maxLength.")

        if declared_type in {"integer", "number"}:
            validate_numeric_bounds(node, declared_type, path)

        enum_values = node.get("enum")
        if enum_values is not None:
            if not isinstance(enum_values, list) or not enum_values:
                fail(f"{path}.enum", "must be a non-empty array.")
            seen_values: list[Any] = []
            for value in enum_values:
                if not isinstance(value, (str, int, float, bool)) or not _validate_type(
                    value, declared_type
                ):
                    fail(
                        f"{path}.enum",
                        f'must contain only finite scalar values of type "{declared_type}".',
                    )
                if any(value == seen for seen in seen_values):
                    fail(f"{path}.enum", "must not contain duplicate values.")
                seen_values.append(value)

        if "default" in node:
            default_value = node["default"]
            validate_json_value(default_value, f"{path}.default")
            normalized_default = _apply_schema_defaults(copy.deepcopy(default_value), node)
            default_errors = _validate_schema_value(
                normalized_default,
                node,
                [f"{path}.default"],
            )
            if default_errors:
                fail(
                    f"{path}.default",
                    f"does not satisfy its schema: {'; '.join(default_errors)}",
                )

    validate_node(schema, "payload", 0, is_root=True)


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

    return errors


def _validate_payload(payload: dict[str, Any], schema: dict[str, Any]) -> list[str]:
    if schema.get("type") != "object":
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
        request = parse_json_document(request_json)
        if not isinstance(request, dict):
            return _error(None, "invalid_request", "Request must be a JSON object.")

        request_id = _validated_request_id(request)
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

    except ProtocolValidationError as exc:
        return _error(request_id, exc.code, str(exc))
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
        request = parse_json_document(request_json)
        if not isinstance(request, dict):
            return _error(None, "invalid_request", "Request must be a JSON object.")

        request_id = _validated_request_id(request)
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

        execution = metadata.get("execution", {})
        if isinstance(execution, dict) and execution.get("thread") == "editor_tick":
            return _error(
                request_id,
                "task_required",
                f'Command "{command_name}" must be started as a cooperative task.',
            )

        return _success(request_id, handler(normalized_payload))

    except ProtocolValidationError as exc:
        return _error(request_id, exc.code, str(exc))
    except json.JSONDecodeError as exc:
        return _error(request_id, "invalid_json", str(exc))
    except CommandExecutionError as exc:
        _log_exception("Unreal Editor WebUI command execution failed.")
        return _error(request_id, exc.code, str(exc), **_command_error_extra(exc))
    except Exception as exc:
        _log_exception("Unreal Editor WebUI command handler failed.")
        return _error(
            request_id,
            "handler_exception",
            str(exc),
        )


def _close_cooperative_job(job: CooperativeJob) -> None:
    try:
        job.iterator.close()
    except Exception:
        _log_exception(
            f'Unreal Editor WebUI cooperative command "{job.command_name}" cleanup failed.'
        )


def start_cooperative_command(
    request_json: str,
    permission_policy: dict[str, Any] | None,
    task_id: str,
) -> str:
    """Create, but do not advance, a generator-backed editor-tick command."""

    request_id = None
    try:
        request = parse_json_document(request_json)
        if not isinstance(request, dict):
            return _error(None, "invalid_request", "Request must be a JSON object.")

        request_id = _validated_request_id(request)
        command_name = request.get("command")
        payload = request.get("payload", {})
        if not isinstance(command_name, str) or not command_name:
            return _error(request_id, "invalid_command", "Command must be a non-empty string.")
        if not isinstance(task_id, str) or not task_id:
            return _error(request_id, "invalid_task_id", "Task id must be a non-empty string.")
        if task_id in COOPERATIVE_JOBS:
            return _error(request_id, "task_exists", f"Cooperative task already exists: {task_id}")
        if len(COOPERATIVE_JOBS) >= MAX_COOPERATIVE_JOBS:
            return _error(
                request_id,
                "too_many_tasks",
                f"Too many active cooperative tasks. Limit: {MAX_COOPERATIVE_JOBS}.",
            )

        handler = COMMANDS.get(command_name)
        metadata = COMMAND_METADATA.get(command_name)
        if handler is None or metadata is None:
            return _error(request_id, "unknown_command", f"Unknown command: {command_name}")

        execution = metadata.get("execution", {})
        if not isinstance(execution, dict) or execution.get("thread") != "editor_tick":
            return _error(
                request_id,
                "invalid_execution_mode",
                f'Command "{command_name}" is not an editor-tick cooperative command.',
            )

        permission = str(metadata.get("permission", "read"))
        policy = _permission_policy(permission_policy)
        if not _permission_allowed(command_name, permission, policy):
            return _error(
                request_id,
                "permission_denied",
                f'Command "{command_name}" requires {permission} permission.',
            )

        schema = metadata.get("schema", {})
        normalized_payload, payload_error = _prepare_command_payload(
            request_id, command_name, payload, schema
        )
        if payload_error is not None:
            return payload_error

        iterator = handler(normalized_payload)
        if not inspect.isgenerator(iterator):
            return _error(
                request_id,
                "invalid_cooperative_handler",
                f'Cooperative command "{command_name}" must return a generator.',
            )

        COOPERATIVE_JOBS[task_id] = CooperativeJob(
            request_id=request_id,
            command_name=command_name,
            iterator=iterator,
        )
        return _success(
            request_id,
            {
                "taskId": task_id,
                "status": "running",
                "progress": 0,
                "log": f'Cooperative command "{command_name}" started.',
            },
        )
    except ProtocolValidationError as exc:
        return _error(request_id, exc.code, str(exc))
    except json.JSONDecodeError as exc:
        return _error(request_id, "invalid_json", str(exc))
    except CommandExecutionError as exc:
        _log_exception("Unreal Editor WebUI cooperative command start failed.")
        return _error(request_id, exc.code, str(exc), **_command_error_extra(exc))
    except Exception as exc:
        _log_exception("Unreal Editor WebUI cooperative command start failed.")
        return _error(request_id, "handler_exception", str(exc))


def step_cooperative_command(control_json: str) -> str:
    """Advance or cancel one generator-backed task and return a lifecycle update."""

    request_id = None
    task_id = ""
    try:
        control = parse_json_document(control_json)
        if not isinstance(control, dict):
            return _error(None, "invalid_request", "Cooperative control must be a JSON object.")

        request_id = _validated_request_id(control)
        task_id = control.get("taskId", "")
        cancel_requested = control.get("cancelRequested", False)
        if not isinstance(task_id, str) or not task_id:
            return _error(request_id, "invalid_task_id", "Task id must be a non-empty string.")
        if not isinstance(cancel_requested, bool):
            return _error(request_id, "invalid_request", "cancelRequested must be a boolean.")

        job = COOPERATIVE_JOBS.get(task_id)
        if job is None:
            return _error(request_id, "task_not_found", f"Cooperative task not found: {task_id}")

        if cancel_requested:
            COOPERATIVE_JOBS.pop(task_id, None)
            _close_cooperative_job(job)
            return _success(
                job.request_id,
                {
                    "taskId": task_id,
                    "status": "cancelled",
                    "progress": 100,
                    "log": "Cooperative command cancelled and cleaned up.",
                },
            )

        try:
            update = next(job.iterator)
        except StopIteration as completed:
            COOPERATIVE_JOBS.pop(task_id, None)
            return _success(
                job.request_id,
                {
                    "taskId": task_id,
                    "status": "completed",
                    "progress": 100,
                    "log": "Cooperative command completed.",
                    "commandResponse": {
                        "id": job.request_id,
                        "ok": True,
                        "result": completed.value,
                    },
                },
            )
        except CommandExecutionError as exc:
            COOPERATIVE_JOBS.pop(task_id, None)
            _close_cooperative_job(job)
            _log_exception("Unreal Editor WebUI cooperative command failed.")
            return _error(job.request_id, exc.code, str(exc), **_command_error_extra(exc))
        except Exception as exc:
            COOPERATIVE_JOBS.pop(task_id, None)
            _close_cooperative_job(job)
            _log_exception("Unreal Editor WebUI cooperative command failed.")
            return _error(job.request_id, "handler_exception", str(exc))

        if not isinstance(update, dict):
            COOPERATIVE_JOBS.pop(task_id, None)
            _close_cooperative_job(job)
            return _error(
                job.request_id,
                "invalid_cooperative_update",
                "Cooperative commands must yield JSON objects.",
            )

        progress = update.get("progress")
        log = update.get("log", "")
        if (
            not isinstance(progress, int)
            or isinstance(progress, bool)
            or progress < 0
            or progress >= 100
            or not isinstance(log, str)
        ):
            COOPERATIVE_JOBS.pop(task_id, None)
            _close_cooperative_job(job)
            return _error(
                job.request_id,
                "invalid_cooperative_update",
                "Cooperative updates require integer progress from 0 to 99 and a string log.",
            )

        return _success(
            job.request_id,
            {
                "taskId": task_id,
                "status": "running",
                "progress": progress,
                "log": log,
            },
        )
    except ProtocolValidationError as exc:
        return _error(request_id, exc.code, str(exc))
    except json.JSONDecodeError as exc:
        return _error(request_id, "invalid_json", str(exc))
    except Exception as exc:
        job = COOPERATIVE_JOBS.pop(task_id, None) if task_id else None
        if job is not None:
            _close_cooperative_job(job)
        _log_exception("Unreal Editor WebUI cooperative command dispatch failed.")
        return _error(request_id, "handler_exception", str(exc))


def cancel_all_cooperative_commands(control_json: str = "{}") -> str:
    """Close every active generator, for example when its browser session ends."""

    request_id = None
    try:
        control = parse_json_document(control_json)
        if not isinstance(control, dict):
            return _error(None, "invalid_request", "Cooperative control must be a JSON object.")
        request_id = _validated_request_id(control)

        jobs = list(COOPERATIVE_JOBS.values())
        COOPERATIVE_JOBS.clear()
        for job in jobs:
            _close_cooperative_job(job)
        return _success(request_id, {"cancelled": len(jobs)})
    except ProtocolValidationError as exc:
        return _error(request_id, exc.code, str(exc))
    except json.JSONDecodeError as exc:
        return _error(request_id, "invalid_json", str(exc))
    except Exception as exc:
        _log_exception("Unreal Editor WebUI cooperative cleanup failed.")
        return _error(request_id, "handler_exception", str(exc))


load_command_modules()
