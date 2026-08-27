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
from contextlib import contextmanager
from dataclasses import dataclass
from heapq import nsmallest
from importlib import util as importlib_util
from importlib.machinery import PathFinder
from pathlib import Path
from types import GeneratorType
from typing import Any, Callable, Iterator

import unreal

from unreal_editor_webui_sdk import CommandExecutionError, SDK_API_VERSION
from unreal_editor_webui_toolpack_integrity import (
    ToolPackIntegrityError,
    ToolPackPolicy,
    compute_tool_pack_payload_sha256,
    load_project_tool_pack_policy,
)
from unreal_editor_webui_toolpacks import (
    COMMAND_NAME_PATTERN,
    MAX_COMMAND_NAME_LENGTH,
    ToolPackDescriptor,
    discover_tool_packs,
)

CommandHandler = Callable[[dict[str, Any]], Any]
COMMANDS: dict[str, CommandHandler] = {}
COMMAND_METADATA: dict[str, dict[str, Any]] = {}
COMMAND_OWNERS: dict[str, str] = {}
COMMAND_LOAD_ERRORS: list[dict[str, str]] = []
COOPERATIVE_JOBS: dict[str, "CooperativeJob"] = {}
METADATA_VERSION = 1
TOOL_PACK_STATUS_VERSION = 2
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
MAX_COMMAND_COUNT = 256
MAX_COMMAND_METADATA_BYTES = 256 * 1024
MAX_COMMAND_CATALOG_BYTES = 3 * 1024 * 1024
MAX_TOOL_PACK_MODULE_COUNT = 256
MAX_COMMAND_LOAD_ERRORS = 128
MAX_TOOL_PACK_STATUS_COUNT = MAX_COMMAND_COUNT + MAX_COMMAND_LOAD_ERRORS
MAX_TOOL_PACK_DESCRIPTOR_COUNT = MAX_TOOL_PACK_STATUS_COUNT
MAX_TOOL_PACK_DISCOVERY_ERROR_COUNT = MAX_TOOL_PACK_STATUS_COUNT
MAX_TOOL_PACK_TRUNCATED_COUNT = 2_147_483_647
TOOL_PACK_STATUS_REASON_CODES = frozenset(
    {
        "command_namespace_conflict",
        "command_registration_rejected",
        "dependency_hash_mismatch",
        "dependency_policy_invalid",
        "entry_import_failed",
        "entry_module_ambiguous",
        "entry_module_duplicate",
        "entry_module_invalid",
        "entry_module_missing",
        "entry_modules_invalid",
        "in_process_native_dependency_unsupported",
        "pack_id_conflict",
        "plugin_name_conflict",
        "python_package_conflict",
        "startup_hook_forbidden",
        "tool_pack_conflict",
        "trust_anchor_missing",
        "trust_policy_invalid",
        "trusted_core_api_mismatch",
        "trusted_pack_missing",
        "trusted_payload_mismatch",
        "trusted_payload_unverifiable",
        "trusted_plugin_version_mismatch",
        "undeclared_registration_origin",
        "unlocked_vendored_dependencies",
        "validation_failed",
        "vendored_dependencies_missing",
    }
)
GENERIC_HANDLER_ERROR_MESSAGE = "Command failed unexpectedly; see the Unreal Log."
COMMAND_METADATA_KEYS = {
    "metadataVersion",
    "name",
    "description",
    "permission",
    "schema",
    "supportsDryRun",
    "category",
    "icon",
    "tags",
    "order",
    "supportedAssetTypes",
    "ui",
    "resultType",
    "warnings",
    "execution",
}
COMMAND_EXECUTION_KEYS = {"thread", "cancellationMode", "timeoutPolicy"}
STRICT_DECIMAL_PATTERN = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")
DEFAULT_PERMISSION_POLICY = {
    "allowedCommand": "",
    "allowedPermission": "",
}


@dataclass(frozen=True)
class _CommandRegistrationContext:
    owner: str
    command_namespace: str | None = None
    registration_origins: tuple[tuple[str, str], ...] | None = None


class _ToolPackLoadError(ValueError):
    def __init__(self, reason_code: str, public_error: str) -> None:
        super().__init__(public_error)
        self.reason_code = reason_code
        self.public_error = public_error


@dataclass(frozen=True)
class _ToolPackImportTarget:
    module_name: str
    source_path: Path
    package_directory: Path | None = None


@dataclass(frozen=True)
class _LoadedToolPackFingerprint:
    plugin_name: str
    plugin_version: str
    pack_id: str
    required_core_api: int
    python_package: str
    top_level_python_package: str
    command_namespace: str
    python_root_key: str
    schema_version: int
    entry_modules: tuple[str, ...]
    dependency_policy: tuple[str, str | None, str] | None


class _ToolPackImportGuard:
    def __init__(self, top_level_package: str, targets: list[_ToolPackImportTarget]) -> None:
        self._top_level_package = top_level_package
        self._targets = {target.module_name: target for target in targets}

    def find_spec(
        self,
        fullname: str,
        path: Any = None,
        target: Any = None,
    ) -> Any:
        del path, target
        if (
            fullname != self._top_level_package
            and not fullname.startswith(f"{self._top_level_package}.")
        ):
            return None
        import_target = self._targets.get(fullname)
        if import_target is None:
            raise ImportError("Tool Pack attempted to import a module outside its fixed allowlist.")
        submodule_locations = (
            [str(import_target.package_directory)]
            if import_target.package_directory is not None
            else None
        )
        spec = importlib_util.spec_from_file_location(
            fullname,
            str(import_target.source_path),
            submodule_search_locations=submodule_locations,
        )
        if spec is None or spec.loader is None:
            raise ImportError("Tool Pack allowlisted module could not create an exact file loader.")
        return spec


_ACTIVE_REGISTRATION_CONTEXT: _CommandRegistrationContext | None = None
_LOADED_TOOL_PACK_IDS: set[str] = set()
_LOADED_TOOL_PACK_FINGERPRINTS: dict[str, _LoadedToolPackFingerprint] = {}
_TOOL_PACK_PYTHON_ROOTS: list[str] = []
_TOOL_PACK_STATUSES: list[dict[str, Any]] = []
_TOOL_PACK_STATUS_META = {"truncatedCount": 0}
_TOOL_PACK_POLICY_STATUS: dict[str, Any] = {
    "enforced": False,
    "state": "disabled",
    "reasonCodes": [],
}


_PUBLIC_TOOL_PACK_ID_PATTERN = re.compile(
    r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+\Z"
)
_PUBLIC_TOOL_PACK_LABEL_PATTERN = re.compile(r"[^A-Za-z0-9_.-]+")
_MAX_PUBLIC_TOOL_PACK_LABEL_LENGTH = 128


def _command_error_extra(error: CommandExecutionError) -> dict[str, Any]:
    extra: dict[str, Any] = {}
    if error.details is not None:
        extra["details"] = error.details
    if error.data is not None:
        extra["data"] = error.data
    return extra


def _append_command_load_error(module: str, error: str) -> None:
    if len(COMMAND_LOAD_ERRORS) >= MAX_COMMAND_LOAD_ERRORS:
        return
    normalized_module = module.strip() if isinstance(module, str) else ""
    normalized_error = error.strip() if isinstance(error, str) else ""
    if not normalized_module or not normalized_error:
        return
    COMMAND_LOAD_ERRORS.append(
        {
            "module": normalized_module[:144],
            "error": normalized_error[:512],
        }
    )


def _public_tool_pack_label(value: Any, fallback: str = "unknown") -> str:
    text = str(value).strip() if value is not None else ""
    text = _PUBLIC_TOOL_PACK_LABEL_PATTERN.sub("-", text).strip("-.")
    return text[:_MAX_PUBLIC_TOOL_PACK_LABEL_LENGTH] or fallback


def _public_tool_pack_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if (
        not normalized
        or len(normalized) > _MAX_PUBLIC_TOOL_PACK_LABEL_LENGTH
        or _PUBLIC_TOOL_PACK_ID_PATTERN.fullmatch(normalized) is None
    ):
        return None
    return normalized


def _public_tool_pack_reason_codes(values: Any) -> list[str]:
    if not isinstance(values, (list, tuple, set, frozenset)):
        return []
    return sorted(
        {
            value
            for value in values
            if isinstance(value, str) and value in TOOL_PACK_STATUS_REASON_CODES
        }
    )[:8]


def _tool_pack_status_record(
    descriptor: ToolPackDescriptor,
    state: str,
    commands: list[str] | None = None,
    reason_codes: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    pack_id = _public_tool_pack_id(descriptor.pack_id)
    required_core_api = descriptor.required_core_api
    if (
        isinstance(required_core_api, bool)
        or not isinstance(required_core_api, int)
        or required_core_api <= 0
    ):
        required_core_api = None
    owned_commands = (
        sorted(set(commands or []))[:MAX_COMMAND_COUNT]
        if state == "loaded"
        else []
    )
    return {
        "provider": pack_id,
        "packId": pack_id,
        "pluginName": _public_tool_pack_label(descriptor.plugin_name),
        "pluginVersion": _public_tool_pack_label(descriptor.plugin_version),
        "requiredCoreApi": required_core_api,
        "state": "loaded" if state == "loaded" else "rejected",
        "commandCount": len(owned_commands),
        "commands": owned_commands,
        "reasonCodes": (
            []
            if state == "loaded"
            else _public_tool_pack_reason_codes(reason_codes or ["validation_failed"])
        ),
    }


def _tool_pack_discovery_error_status(diagnostic: Any) -> dict[str, Any] | None:
    if not isinstance(diagnostic, dict):
        return None
    module = diagnostic.get("module")
    if not isinstance(module, str) or not module.startswith("plugin:"):
        return None
    plugin_label = module[len("plugin:") :]
    if not plugin_label or plugin_label == "discovery":
        return None
    return {
        "provider": None,
        "packId": None,
        "pluginName": _public_tool_pack_label(plugin_label),
        "pluginVersion": None,
        "requiredCoreApi": None,
        "state": "rejected",
        "commandCount": 0,
        "commands": [],
        "reasonCodes": _public_tool_pack_reason_codes(
            [diagnostic.get("reasonCode", "validation_failed")]
        ) or ["validation_failed"],
    }


def _tool_pack_status_sort_key(record: dict[str, Any]) -> tuple[Any, ...]:
    pack_id = record.get("packId")
    plugin_name = str(record.get("pluginName", ""))
    return (
        pack_id is None,
        str(pack_id or "").casefold(),
        plugin_name.casefold(),
        plugin_name,
    )


def _publish_tool_pack_statuses(
    records: list[dict[str, Any]],
    omitted_count: int = 0,
) -> None:
    by_plugin: dict[str, dict[str, Any]] = {
        str(record.get("pluginName", "")).casefold(): copy.deepcopy(record)
        for record in _TOOL_PACK_STATUSES
        if isinstance(record, dict) and str(record.get("pluginName", "")).strip()
    }
    for record in records:
        plugin_name = str(record.get("pluginName", "")).strip()
        if plugin_name:
            plugin_key = plugin_name.casefold()
            existing = by_plugin.get(plugin_key)
            if (
                isinstance(existing, dict)
                and existing.get("state") == "loaded"
                and record.get("state") != "loaded"
            ):
                continue
            by_plugin[plugin_key] = copy.deepcopy(record)

    loaded = sorted(
        (record for record in by_plugin.values() if record.get("state") == "loaded"),
        key=_tool_pack_status_sort_key,
    )
    rejected = sorted(
        (record for record in by_plugin.values() if record.get("state") != "loaded"),
        key=_tool_pack_status_sort_key,
    )
    visible = loaded[:MAX_TOOL_PACK_STATUS_COUNT]
    remaining = max(0, MAX_TOOL_PACK_STATUS_COUNT - len(visible))
    visible.extend(rejected[:remaining])
    visible.sort(key=_tool_pack_status_sort_key)

    _TOOL_PACK_STATUSES[:] = visible
    # Hidden records are deliberately not retained. This bounded counter is the
    # saturating cumulative number of status observations omitted across
    # publications, rather than a count of distinct providers currently hidden.
    omitted_observations = max(0, int(omitted_count)) + max(
        0,
        len(loaded) + len(rejected) - len(visible),
    )
    _TOOL_PACK_STATUS_META["truncatedCount"] = min(
        MAX_TOOL_PACK_TRUNCATED_COUNT,
        max(0, int(_TOOL_PACK_STATUS_META.get("truncatedCount", 0)))
        + omitted_observations,
    )


def _get_tool_pack_status() -> dict[str, Any]:
    return {
        "statusVersion": TOOL_PACK_STATUS_VERSION,
        "coreApiVersion": SDK_API_VERSION,
        "policy": copy.deepcopy(_TOOL_PACK_POLICY_STATUS),
        "packs": copy.deepcopy(_TOOL_PACK_STATUSES),
        "truncatedCount": int(_TOOL_PACK_STATUS_META["truncatedCount"]),
    }


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


@contextmanager
def _registration_context(
    owner: str,
    command_namespace: str | None = None,
    registration_origins: tuple[tuple[str, str], ...] | None = None,
) -> Iterator[None]:
    global _ACTIVE_REGISTRATION_CONTEXT

    previous = _ACTIVE_REGISTRATION_CONTEXT
    _ACTIVE_REGISTRATION_CONTEXT = _CommandRegistrationContext(
        owner=owner,
        command_namespace=command_namespace,
        registration_origins=registration_origins,
    )
    try:
        yield
    finally:
        _ACTIVE_REGISTRATION_CONTEXT = previous


def _normalize_json_metadata(value: Any, field_name: str) -> Any:
    node_count = 0
    active_containers: set[int] = set()

    def normalize(current: Any, depth: int) -> Any:
        nonlocal node_count

        node_count += 1
        if node_count > MAX_JSON_NODES:
            raise ValueError(
                f'Command metadata field "{field_name}" contains more than {MAX_JSON_NODES} JSON nodes.'
            )
        if depth > MAX_JSON_DEPTH:
            raise ValueError(
                f'Command metadata field "{field_name}" exceeds the maximum JSON depth of {MAX_JSON_DEPTH}.'
            )
        if current is None or isinstance(current, (str, bool, int)):
            return current
        if isinstance(current, float):
            if not math.isfinite(current):
                raise ValueError(
                    f'Command metadata field "{field_name}" must contain only finite JSON numbers '
                    "(finite number values only)."
                )
            return current
        if not isinstance(current, (list, dict)):
            raise ValueError(
                f'Command metadata field "{field_name}" must contain only JSON-compatible values.'
            )

        container_id = id(current)
        if container_id in active_containers:
            raise ValueError(f'Command metadata field "{field_name}" must not contain a cycle.')
        active_containers.add(container_id)
        try:
            if isinstance(current, list):
                return [normalize(item, depth + 1) for item in current]
            if any(not isinstance(key, str) for key in current):
                raise ValueError(
                    f'Command metadata field "{field_name}" must contain only string JSON object keys.'
                )
            return {
                str(key): normalize(item, depth + 1)
                for key, item in current.items()
            }
        finally:
            active_containers.remove(container_id)

    return normalize(value, 0)


def _normalize_metadata_string_list(value: Any, field_name: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f'Command metadata field "{field_name}" must be an array of strings.')
    return [str(item) for item in value]


def _validate_command_catalog_capacity(
    command_name: str,
    metadata: dict[str, Any],
) -> None:
    try:
        metadata_json = json.dumps(metadata, ensure_ascii=False, allow_nan=False)
    except (RecursionError, TypeError, ValueError) as exc:
        raise ValueError(
            f'Command "{command_name}" metadata must be JSON-serializable.'
        ) from exc
    metadata_bytes = len(metadata_json.encode("utf-8"))
    if metadata_bytes > MAX_COMMAND_METADATA_BYTES:
        raise ValueError(
            f'Command "{command_name}" metadata exceeds the {MAX_COMMAND_METADATA_BYTES}-byte limit.'
        )

    if command_name not in COMMAND_METADATA and len(COMMAND_METADATA) >= MAX_COMMAND_COUNT:
        raise ValueError(f"Command registry exceeds the {MAX_COMMAND_COUNT}-command limit.")

    projected_metadata = dict(COMMAND_METADATA)
    projected_metadata[command_name] = metadata
    projected_catalog = {
        "metadataVersion": METADATA_VERSION,
        "commands": [projected_metadata[name] for name in sorted(projected_metadata)],
        "loadErrors": [],
    }
    try:
        projected_json = json.dumps(
            projected_catalog,
            ensure_ascii=False,
            allow_nan=False,
        )
    except (RecursionError, TypeError, ValueError) as exc:
        raise ValueError("Existing command metadata is not JSON-serializable.") from exc
    projected_bytes = len(projected_json.encode("utf-8"))
    if projected_bytes > MAX_COMMAND_CATALOG_BYTES:
        raise ValueError(
            f"Command catalogue exceeds the {MAX_COMMAND_CATALOG_BYTES}-byte metadata budget."
        )


def _validate_command_name(name: Any) -> str:
    if (
        not isinstance(name, str)
        or not name
        or len(name) > MAX_COMMAND_NAME_LENGTH
        or COMMAND_NAME_PATTERN.fullmatch(name) is None
    ):
        raise ValueError(
            "Command name must be a dotted ASCII identifier no longer than "
            f"{MAX_COMMAND_NAME_LENGTH} characters; each segment must start with a "
            "lowercase letter and contain only letters, digits, or underscores."
        )
    return name


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

    normalized_name = _validate_command_name(name)
    normalized_permission = permission.lower().strip() if isinstance(permission, str) else ""
    normalized_execution_thread = execution_thread.lower().strip() if isinstance(execution_thread, str) else ""
    normalized_cancellation_mode = cancellation_mode.lower().strip() if isinstance(cancellation_mode, str) else ""
    normalized_timeout_policy = timeout_policy.lower().strip() if isinstance(timeout_policy, str) else ""
    registration_context = _ACTIVE_REGISTRATION_CONTEXT
    if registration_context is None:
        raise RuntimeError(
            "Command registration is closed outside an explicit Unreal Editor WebUI load context."
        )
    normalized_schema = _normalize_json_metadata(
        schema if schema is not None else {"type": "object", "properties": {}},
        "schema",
    )

    if (
        registration_context.command_namespace is not None
        and not normalized_name.startswith(f"{registration_context.command_namespace}.")
    ):
        raise _ToolPackLoadError(
            "command_registration_rejected",
            f'Tool Pack command must use namespace "{registration_context.command_namespace}."; '
            "the package was not loaded."
        )
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

    if not isinstance(description, str):
        raise ValueError("Command metadata field \"description\" must be a string.")
    if not isinstance(supports_dry_run, bool):
        raise ValueError("Command metadata field \"supportsDryRun\" must be a boolean.")
    if not isinstance(category, str):
        raise ValueError("Command metadata field \"category\" must be a string.")
    if not isinstance(icon, str):
        raise ValueError("Command metadata field \"icon\" must be a string.")
    if not isinstance(order, int) or isinstance(order, bool):
        raise ValueError("Command metadata field \"order\" must be an integer.")
    if not isinstance(result_type, str):
        raise ValueError("Command metadata field \"resultType\" must be a string.")

    normalized_tags = _normalize_metadata_string_list(tags, "tags")
    normalized_asset_types = _normalize_metadata_string_list(
        supported_asset_types,
        "supportedAssetTypes",
    )
    normalized_warnings = _normalize_metadata_string_list(warnings, "warnings")
    normalized_ui = _normalize_json_metadata(ui if ui is not None else {}, "ui")
    if not isinstance(normalized_ui, dict):
        raise ValueError("Command metadata field \"ui\" must be an object.")

    normalized_metadata = {
        "metadataVersion": METADATA_VERSION,
        "name": normalized_name,
        "description": str(description),
        "permission": normalized_permission,
        "schema": normalized_schema,
        "supportsDryRun": supports_dry_run,
        "category": str(category),
        "icon": str(icon),
        "tags": normalized_tags,
        "order": order,
        "supportedAssetTypes": normalized_asset_types,
        "ui": normalized_ui,
        "resultType": str(result_type),
        "warnings": normalized_warnings,
        "execution": {
            "thread": normalized_execution_thread,
            "cancellationMode": normalized_cancellation_mode,
            "timeoutPolicy": normalized_timeout_policy,
        },
    }

    def decorator(handler: CommandHandler) -> CommandHandler:
        if _ACTIVE_REGISTRATION_CONTEXT is not registration_context:
            raise RuntimeError(
                f'Command "{normalized_name}" decorator was applied outside its registration context.'
            )
        if not callable(handler):
            raise ValueError(f'Command "{normalized_name}" handler must be callable.')
        if registration_context.registration_origins is not None:
            module_name = getattr(handler, "__module__", None)
            allowed_origins = dict(registration_context.registration_origins)
            expected_origin = (
                allowed_origins.get(module_name)
                if isinstance(module_name, str)
                else None
            )
            try:
                source_file = inspect.getsourcefile(handler)
                source_key = _path_key(Path(source_file).resolve(strict=True)) if source_file else ""
            except (OSError, RuntimeError, TypeError, ValueError):
                source_key = ""
            if expected_origin is None or source_key != expected_origin:
                raise _ToolPackLoadError(
                    "undeclared_registration_origin",
                    "Tool Pack command registration must originate from a declared entry module.",
                )
        if normalized_name in COMMANDS:
            raise ValueError(f'Command "{normalized_name}" is already registered.')
        _validate_command_catalog_capacity(normalized_name, normalized_metadata)
        COMMANDS[normalized_name] = handler
        COMMAND_OWNERS[normalized_name] = registration_context.owner
        COMMAND_METADATA[normalized_name] = normalized_metadata
        return handler

    return decorator


def _sdk_command(
    name: str,
    **metadata: Any,
) -> Callable[[CommandHandler], CommandHandler]:
    if _ACTIVE_REGISTRATION_CONTEXT is None:
        raise RuntimeError(
            "Unreal Editor WebUI SDK commands may only register while the core is loading "
            "built-in modules or an enabled Tool Pack."
        )
    return command(name, **metadata)


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


def _normalize_registered_command_metadata(
    command_name: str,
    metadata: Any,
) -> dict[str, Any]:
    normalized = _normalize_json_metadata(metadata, f'command "{command_name}"')
    if not isinstance(normalized, dict) or set(normalized) != COMMAND_METADATA_KEYS:
        raise ValueError(f'Command "{command_name}" metadata does not match schema v1.')
    if normalized["metadataVersion"] != METADATA_VERSION or isinstance(
        normalized["metadataVersion"],
        bool,
    ):
        raise ValueError(f'Command "{command_name}" metadataVersion is invalid.')
    if normalized["name"] != command_name:
        raise ValueError(f'Command "{command_name}" metadata name does not match its registry key.')

    for field_name in ("description", "category", "icon", "resultType"):
        if not isinstance(normalized[field_name], str):
            raise ValueError(f'Command "{command_name}" metadata field "{field_name}" must be a string.')
    if not isinstance(normalized["permission"], str) or normalized["permission"] not in SUPPORTED_PERMISSIONS:
        raise ValueError(f'Command "{command_name}" metadata permission is invalid.')
    if not isinstance(normalized["supportsDryRun"], bool):
        raise ValueError(f'Command "{command_name}" metadata supportsDryRun must be a boolean.')
    if not isinstance(normalized["order"], int) or isinstance(normalized["order"], bool):
        raise ValueError(f'Command "{command_name}" metadata order must be an integer.')
    for field_name in ("tags", "supportedAssetTypes", "warnings"):
        _normalize_metadata_string_list(normalized[field_name], field_name)
    if not isinstance(normalized["ui"], dict):
        raise ValueError(f'Command "{command_name}" metadata ui must be an object.')
    if not isinstance(normalized["schema"], dict):
        raise ValueError(f'Command "{command_name}" metadata schema must be an object.')
    _validate_command_schema(command_name, normalized["schema"])

    execution = normalized["execution"]
    if not isinstance(execution, dict) or set(execution) != COMMAND_EXECUTION_KEYS:
        raise ValueError(f'Command "{command_name}" execution metadata is invalid.')
    if any(not isinstance(execution[key], str) for key in COMMAND_EXECUTION_KEYS):
        raise ValueError(f'Command "{command_name}" execution metadata must contain strings.')
    _validate_execution_metadata(
        command_name,
        execution["thread"],
        execution["cancellationMode"],
        execution["timeoutPolicy"],
    )
    return normalized


def _validate_tool_pack_registry_state(new_commands: list[str]) -> None:
    command_names = set(COMMANDS)
    if command_names != set(COMMAND_METADATA) or command_names != set(COMMAND_OWNERS):
        raise ValueError("Tool Pack left inconsistent command registry mappings.")
    if len(command_names) > MAX_COMMAND_COUNT:
        raise ValueError(f"Command registry exceeds the {MAX_COMMAND_COUNT}-command limit.")

    for command_name in new_commands:
        _validate_command_name(command_name)
        if not callable(COMMANDS[command_name]):
            raise ValueError(f'Command "{command_name}" handler must be callable.')
        COMMAND_METADATA[command_name] = _normalize_registered_command_metadata(
            command_name,
            COMMAND_METADATA[command_name],
        )

    for command_name in new_commands:
        _validate_command_catalog_capacity(command_name, COMMAND_METADATA[command_name])


def _import_command_module(module_name: str, package_name: str) -> Any:
    handlers_before = dict(COMMANDS)
    metadata_before = copy.deepcopy(COMMAND_METADATA)
    owners_before = dict(COMMAND_OWNERS)
    modules_before = set(sys.modules)
    try:
        return importlib.import_module(module_name)
    except Exception:
        COMMANDS.clear()
        COMMANDS.update(handlers_before)
        COMMAND_METADATA.clear()
        COMMAND_METADATA.update(metadata_before)
        COMMAND_OWNERS.clear()
        COMMAND_OWNERS.update(owners_before)
        for loaded_module in set(sys.modules).difference(modules_before):
            if loaded_module == package_name or loaded_module.startswith(f"{package_name}."):
                sys.modules.pop(loaded_module, None)
        raise


def load_command_modules(package_name: str = "unreal_editor_webui_commands") -> None:
    try:
        package = _import_command_module(package_name, package_name)
    except Exception as exc:
        _append_command_load_error(package_name, str(exc))
        return

    package_paths = getattr(package, "__path__", None)
    if package_paths is None:
        _append_command_load_error(
            package_name,
            "Command package does not expose __path__.",
        )
        return

    for module_info in sorted(pkgutil.iter_modules(package_paths), key=lambda item: item.name):
        module_name = f"{package_name}.{module_info.name}"
        try:
            _import_command_module(module_name, package_name)
        except Exception as exc:
            _append_command_load_error(module_name, str(exc))


def _tool_pack_diagnostic(
    descriptor: ToolPackDescriptor,
    error: str,
    reason_code: str = "validation_failed",
) -> dict[str, str]:
    return {
        "module": f"toolpack:{descriptor.pack_id}"[:144],
        "error": error[:512],
        "reasonCode": (
            reason_code
            if reason_code in TOOL_PACK_STATUS_REASON_CODES
            else "validation_failed"
        ),
    }


def _path_key(value: str | Path) -> str:
    try:
        return str(Path(value).resolve(strict=False)).casefold()
    except (OSError, RuntimeError, TypeError, ValueError):
        return str(value).casefold()


def _tool_pack_fingerprint(
    descriptor: ToolPackDescriptor,
    python_root: Path | None = None,
) -> _LoadedToolPackFingerprint:
    dependency_policy = descriptor.dependency_policy
    return _LoadedToolPackFingerprint(
        plugin_name=descriptor.plugin_name,
        plugin_version=descriptor.plugin_version,
        pack_id=descriptor.pack_id,
        required_core_api=descriptor.required_core_api,
        python_package=descriptor.python_package,
        top_level_python_package=descriptor.python_package.split(".", 1)[0].casefold(),
        command_namespace=descriptor.command_namespace,
        python_root_key=_path_key(python_root or descriptor.python_root),
        schema_version=descriptor.schema_version,
        entry_modules=tuple(descriptor.entry_modules),
        dependency_policy=(
            (
                dependency_policy.pure_python,
                dependency_policy.pure_python_tree_sha256,
                dependency_policy.native,
            )
            if dependency_policy is not None
            else None
        ),
    )


def _tool_pack_owned_commands(pack_id: str) -> list[str]:
    return sorted(
        command_name
        for command_name, owner in COMMAND_OWNERS.items()
        if owner == pack_id
    )[:MAX_COMMAND_COUNT]


def _tool_pack_namespaces_overlap(left: str, right: str) -> bool:
    normalized_left = left.casefold()
    normalized_right = right.casefold()
    return (
        normalized_left == normalized_right
        or normalized_left.startswith(f"{normalized_right}.")
        or normalized_right.startswith(f"{normalized_left}.")
    )


def _prepare_tool_pack_python_path(
    python_root: Path,
    *,
    prioritize: bool = False,
) -> tuple[list[str], str]:
    root_text = str(python_root)
    root_key = _path_key(root_text)
    desired_path = [entry for entry in sys.path if _path_key(entry) != root_key]

    if prioritize:
        desired_path.insert(0, root_text)
        return desired_path, root_text

    core_root_key = _path_key(Path(__file__).parent)
    insert_at = 0
    for index, entry in enumerate(desired_path):
        if _path_key(entry) == core_root_key:
            insert_at = index + 1
            break

    loaded_root_keys = {_path_key(item) for item in _TOOL_PACK_PYTHON_ROOTS}
    while insert_at < len(desired_path) and _path_key(desired_path[insert_at]) in loaded_root_keys:
        insert_at += 1
    desired_path.insert(insert_at, root_text)
    return desired_path, root_text


def _is_path_inside(parent: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(parent)
        return True
    except ValueError:
        return False


def _resolve_import_path(value: str, expected_root: Path) -> Path:
    try:
        resolved = Path(value).resolve(strict=True)
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        raise ValueError("Tool Pack import path is unavailable.") from exc
    if not _is_path_inside(expected_root, resolved):
        raise ValueError("Tool Pack import path resolved outside its enabled plugin.")
    return resolved


def _preflight_tool_pack_package_chain(
    python_root: Path,
    python_package: str,
) -> tuple[Path, Path, list[_ToolPackImportTarget]]:
    package_parts = python_package.split(".")
    expected_directory = python_root
    expected_init = python_root
    targets: list[_ToolPackImportTarget] = []

    for index, package_part in enumerate(package_parts):
        expected_directory = expected_directory / package_part
        try:
            resolved_directory = expected_directory.resolve(strict=True)
        except (OSError, RuntimeError, ValueError) as exc:
            raise ValueError("Tool Pack Python package is unavailable.") from exc
        if not resolved_directory.is_dir() or not _is_path_inside(python_root, resolved_directory):
            raise ValueError("Tool Pack Python package resolved outside its enabled plugin.")

        module_name = ".".join(package_parts[: index + 1])
        try:
            expected_init = (resolved_directory / "__init__.py").resolve(strict=True)
        except (OSError, RuntimeError, ValueError) as exc:
            raise ValueError("Every Tool Pack package segment must contain __init__.py.") from exc
        if (
            not expected_init.is_file()
            or expected_init.name != "__init__.py"
            or expected_init.suffix != ".py"
            or not _is_path_inside(python_root, expected_init)
        ):
            raise ValueError("Every Tool Pack package segment must contain an internal __init__.py.")
        targets.append(
            _ToolPackImportTarget(
                module_name=module_name,
                source_path=expected_init,
                package_directory=resolved_directory,
            )
        )

    return expected_directory.resolve(strict=True), expected_init, targets


def _reject_foreign_top_level_package(python_root: Path, python_package: str) -> None:
    top_level_package = python_package.split(".", 1)[0]
    if top_level_package in sys.builtin_module_names or top_level_package in getattr(
        sys,
        "stdlib_module_names",
        (),
    ):
        raise ValueError("Tool Pack pythonPackage conflicts with a Python standard-library package.")

    root_key = _path_key(python_root)
    other_paths = [
        entry
        for entry in sys.path
        if isinstance(entry, str) and _path_key(entry) != root_key
    ]
    if PathFinder.find_spec(top_level_package, other_paths) is not None:
        raise ValueError("Tool Pack pythonPackage conflicts with another Python search root.")


def _preflight_tool_pack_modules(
    package_name: str,
    package_directory: Path,
) -> list[_ToolPackImportTarget]:
    targets: dict[str, _ToolPackImportTarget] = {}
    pending: list[tuple[Path, str]] = [(package_directory, f"{package_name}.")]
    while pending:
        current_directory, prefix = pending.pop()
        try:
            entries = sorted(
                current_directory.iterdir(),
                key=lambda item: (item.name.casefold(), item.name),
            )
        except OSError as exc:
            raise ValueError("Tool Pack package directory could not be enumerated.") from exc
        for entry in entries:
            if entry.name == "__init__.py":
                continue
            if entry.is_file() and entry.suffix == ".py" and entry.stem.isidentifier():
                module_name = f"{prefix}{entry.stem}"
                source_path = _resolve_import_path(str(entry), package_directory)
                targets[module_name] = _ToolPackImportTarget(
                    module_name=module_name,
                    source_path=source_path,
                )
            elif entry.is_dir() and entry.name.isidentifier():
                init_candidate = entry / "__init__.py"
                if not init_candidate.is_file():
                    continue
                resolved_child = _resolve_import_path(str(entry), package_directory)
                expected_init = _resolve_import_path(str(init_candidate), package_directory)
                module_name = f"{prefix}{entry.name}"
                targets[module_name] = _ToolPackImportTarget(
                    module_name=module_name,
                    source_path=expected_init,
                    package_directory=resolved_child,
                )
                pending.append((resolved_child, f"{module_name}."))

            if len(targets) > MAX_TOOL_PACK_MODULE_COUNT:
                raise ValueError(
                    f"Tool Pack contains more than {MAX_TOOL_PACK_MODULE_COUNT} importable submodules."
                )

    return [targets[name] for name in sorted(targets)]


def _validate_imported_package_path(package: Any, package_directory: Path) -> None:
    package_paths = getattr(package, "__path__", None)
    if package_paths is None:
        raise ValueError("Tool Pack pythonPackage must expose __path__.")
    try:
        resolved_paths = {
            Path(path).resolve(strict=True)
            for path in package_paths
        }
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        raise ValueError("Tool Pack package search path is unavailable.") from exc
    if resolved_paths != {package_directory}:
        raise ValueError("Tool Pack package search path escaped its fixed package directory.")


def _validate_imported_module_origin(module: Any, expected_origin: Path) -> None:
    module_file = getattr(module, "__file__", None)
    if not isinstance(module_file, str):
        raise ValueError("Tool Pack submodule has no filesystem import origin.")
    try:
        resolved_file = Path(module_file).resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("Tool Pack submodule import origin is unavailable.") from exc
    if resolved_file != expected_origin:
        raise ValueError("Tool Pack submodule did not use its allowlisted file origin.")


def _validate_tool_pack_descriptor(descriptor: ToolPackDescriptor) -> tuple[Path, Path]:
    if descriptor.required_core_api != SDK_API_VERSION:
        raise _ToolPackLoadError(
            "trusted_core_api_mismatch",
            f"Tool Pack requires core API {descriptor.required_core_api}, but this core provides "
            f"API {SDK_API_VERSION}; the package was not loaded."
        )
    if not descriptor.pack_id or not descriptor.python_package or not descriptor.command_namespace:
        raise ValueError("Tool Pack descriptor is incomplete.")
    try:
        python_root = Path(descriptor.python_root).resolve(strict=True)
        package_directory = python_root.joinpath(*descriptor.python_package.split(".")).resolve(strict=True)
        package_directory.relative_to(python_root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("Tool Pack Python package is unavailable.") from exc
    if not python_root.is_dir() or not package_directory.is_dir() or not (package_directory / "__init__.py").is_file():
        raise ValueError("Tool Pack pythonPackage must name a real package containing __init__.py.")
    return python_root, package_directory


def _restore_tool_pack_registry(
    handlers_before: dict[str, CommandHandler],
    metadata_before: dict[str, dict[str, Any]],
    owners_before: dict[str, str],
    load_errors_before: list[dict[str, str]],
    loaded_ids_before: set[str],
    loaded_fingerprints_before: dict[str, _LoadedToolPackFingerprint],
    python_roots_before: list[str],
    statuses_before: list[dict[str, Any]],
    status_meta_before: dict[str, int],
    policy_status_before: dict[str, Any],
) -> None:
    COMMANDS.clear()
    COMMANDS.update(handlers_before)
    COMMAND_METADATA.clear()
    COMMAND_METADATA.update(metadata_before)
    COMMAND_OWNERS.clear()
    COMMAND_OWNERS.update(owners_before)
    COMMAND_LOAD_ERRORS.clear()
    COMMAND_LOAD_ERRORS.extend(load_errors_before)
    _LOADED_TOOL_PACK_IDS.clear()
    _LOADED_TOOL_PACK_IDS.update(loaded_ids_before)
    _LOADED_TOOL_PACK_FINGERPRINTS.clear()
    _LOADED_TOOL_PACK_FINGERPRINTS.update(loaded_fingerprints_before)
    _TOOL_PACK_PYTHON_ROOTS[:] = python_roots_before
    _TOOL_PACK_STATUSES[:] = statuses_before
    _TOOL_PACK_STATUS_META.clear()
    _TOOL_PACK_STATUS_META.update(status_meta_before)
    _TOOL_PACK_POLICY_STATUS.clear()
    _TOOL_PACK_POLICY_STATUS.update(policy_status_before)


def _remove_failed_tool_pack_modules(
    modules_before: dict[str, Any],
    python_package: str,
    python_root: Path,
) -> None:
    top_level_package = python_package.split(".", 1)[0]
    reserved_modules = {
        "unreal_editor_webui_bridge_entry",
        "unreal_editor_webui_registry",
        "unreal_editor_webui_sdk",
        "unreal_editor_webui_toolpacks",
    }
    for module_name, module in list(sys.modules.items()):
        try:
            module_file = getattr(module, "__file__", None)
        except Exception:
            module_file = None
        belongs_to_root = False
        if isinstance(module_file, str) and module_file:
            try:
                belongs_to_root = _is_path_inside(
                    python_root,
                    Path(module_file).resolve(strict=False),
                )
            except (OSError, RuntimeError, ValueError):
                belongs_to_root = False
        if (
            module_name == top_level_package
            or module_name.startswith(f"{top_level_package}.")
            or belongs_to_root
        ) and module_name not in modules_before:
            sys.modules.pop(module_name, None)

    for module_name in reserved_modules:
        previous = modules_before.get(module_name)
        if previous is not None:
            sys.modules[module_name] = previous


def _existing_commands_were_preserved(
    handlers_before: dict[str, CommandHandler],
    metadata_before: dict[str, dict[str, Any]],
    owners_before: dict[str, str],
    load_errors_before: list[dict[str, str]],
    loaded_ids_before: set[str],
    loaded_fingerprints_before: dict[str, _LoadedToolPackFingerprint],
    python_roots_before: list[str],
    statuses_before: list[dict[str, Any]],
    status_meta_before: dict[str, int],
    policy_status_before: dict[str, Any],
) -> bool:
    if COMMAND_LOAD_ERRORS != load_errors_before:
        return False
    if _LOADED_TOOL_PACK_IDS != loaded_ids_before:
        return False
    if _LOADED_TOOL_PACK_FINGERPRINTS != loaded_fingerprints_before:
        return False
    if _TOOL_PACK_PYTHON_ROOTS != python_roots_before:
        return False
    if _TOOL_PACK_STATUSES != statuses_before:
        return False
    if _TOOL_PACK_STATUS_META != status_meta_before:
        return False
    if _TOOL_PACK_POLICY_STATUS != policy_status_before:
        return False
    for command_name, handler in handlers_before.items():
        if COMMANDS.get(command_name) is not handler:
            return False
        if COMMAND_METADATA.get(command_name) != metadata_before.get(command_name):
            return False
        if COMMAND_OWNERS.get(command_name) != owners_before.get(command_name):
            return False
    return True


def _load_tool_pack_descriptor(descriptor: ToolPackDescriptor) -> dict[str, str] | None:
    try:
        handlers_before = dict(COMMANDS)
        metadata_before = copy.deepcopy(COMMAND_METADATA)
        owners_before = dict(COMMAND_OWNERS)
        load_errors_before = copy.deepcopy(COMMAND_LOAD_ERRORS)
        loaded_ids_before = set(_LOADED_TOOL_PACK_IDS)
        loaded_fingerprints_before = dict(_LOADED_TOOL_PACK_FINGERPRINTS)
        python_roots_before = list(_TOOL_PACK_PYTHON_ROOTS)
        statuses_before = copy.deepcopy(_TOOL_PACK_STATUSES)
        status_meta_before = dict(_TOOL_PACK_STATUS_META)
        policy_status_before = copy.deepcopy(_TOOL_PACK_POLICY_STATUS)
        modules_before = dict(sys.modules)
        sys_path_before = list(sys.path)
        meta_path_container_before = sys.meta_path
        if not isinstance(meta_path_container_before, list):
            raise TypeError("sys.meta_path must be a list.")
        sys_meta_path_before = list(meta_path_container_before)
    except Exception:
        _log_exception(
            f'Unreal Editor WebUI could not snapshot state before Tool Pack "{descriptor.pack_id}".'
        )
        return _tool_pack_diagnostic(
            descriptor,
            "Tool Pack could not start an isolated load; see the Unreal Log.",
            "entry_import_failed",
        )

    python_root: Path | None = None
    root_text = ""

    try:
        python_root, package_directory = _validate_tool_pack_descriptor(descriptor)
        top_level_package = descriptor.python_package.split(".", 1)[0]
        if any(
            module_name == top_level_package or module_name.startswith(f"{top_level_package}.")
            for module_name in sys.modules
        ):
            raise ValueError("Tool Pack Python package was imported before registry discovery.")

        (
            expected_package_directory,
            _expected_package_init,
            package_chain_targets,
        ) = _preflight_tool_pack_package_chain(
            python_root,
            descriptor.python_package,
        )
        if expected_package_directory != package_directory:
            raise ValueError("Tool Pack pythonPackage did not match its fixed package directory.")
        _reject_foreign_top_level_package(python_root, descriptor.python_package)
        module_targets = _preflight_tool_pack_modules(
            descriptor.python_package,
            package_directory,
        )
        import_targets = [*package_chain_targets, *module_targets]
        import_guard = _ToolPackImportGuard(top_level_package, import_targets)
        targets_to_import = import_targets
        registration_origins: tuple[tuple[str, str], ...] | None = None
        if descriptor.schema_version == 2:
            target_by_name = {target.module_name: target for target in import_targets}
            entry_targets: list[_ToolPackImportTarget] = []
            for entry_module in descriptor.entry_modules:
                full_name = f"{descriptor.python_package}.{entry_module}"
                import_target = target_by_name.get(full_name)
                if import_target is None:
                    raise _ToolPackLoadError(
                        "entry_module_missing",
                        "Tool Pack declared entry module is unavailable; the package was not loaded.",
                    )
                entry_targets.append(import_target)
            targets_to_import = sorted(entry_targets, key=lambda item: item.module_name)
            registration_origins = tuple(
                (target.module_name, _path_key(target.source_path))
                for target in targets_to_import
            )

        desired_path, root_text = _prepare_tool_pack_python_path(
            python_root,
            prioritize=True,
        )
        sys.path[:] = desired_path
        meta_path_container_before[:] = [import_guard, *sys_meta_path_before]
        sys.meta_path = meta_path_container_before
        try:
            with _registration_context(
                descriptor.pack_id,
                descriptor.command_namespace,
                registration_origins,
            ):
                if descriptor.schema_version == 1:
                    importlib.import_module(descriptor.python_package)
                for import_target in targets_to_import:
                    # Reassert the scoped guard before each import so ordinary package
                    # side effects cannot accidentally expose the declared prefix to a
                    # preinstalled finder later in the deterministic traversal.
                    meta_path_container_before[:] = [import_guard, *sys_meta_path_before]
                    sys.meta_path = meta_path_container_before
                    module = importlib.import_module(import_target.module_name)
                    _validate_imported_module_origin(module, import_target.source_path)
                    if import_target.package_directory is not None:
                        _validate_imported_package_path(
                            module,
                            import_target.package_directory,
                        )
        finally:
            meta_path_container_before[:] = sys_meta_path_before
            sys.meta_path = meta_path_container_before

        if not _existing_commands_were_preserved(
            handlers_before,
            metadata_before,
            owners_before,
            load_errors_before,
            loaded_ids_before,
            loaded_fingerprints_before,
            python_roots_before,
            statuses_before,
            status_meta_before,
            policy_status_before,
        ):
            raise ValueError("Tool Pack modified commands owned by another provider.")

        new_commands = sorted(set(COMMANDS).difference(handlers_before))
        if not new_commands:
            raise ValueError("Tool Pack did not register any commands.")
        for command_name in new_commands:
            if COMMAND_OWNERS.get(command_name) != descriptor.pack_id:
                raise ValueError("Tool Pack registered a command without an owner.")
            if not command_name.startswith(f"{descriptor.command_namespace}."):
                raise ValueError("Tool Pack registered a command outside its namespace.")
            if command_name not in COMMAND_METADATA:
                raise ValueError("Tool Pack registered a command without metadata.")
        _validate_tool_pack_registry_state(new_commands)

        # Preserve only the core-managed Python root insertion. A package cannot
        # persist arbitrary import path or finder edits as a side effect of registration.
        sys.path[:] = sys_path_before
        desired_path, _ = _prepare_tool_pack_python_path(python_root)
        sys.path[:] = desired_path
        _TOOL_PACK_PYTHON_ROOTS.append(root_text)
        _LOADED_TOOL_PACK_IDS.add(descriptor.pack_id)
        _LOADED_TOOL_PACK_FINGERPRINTS[descriptor.pack_id] = _tool_pack_fingerprint(
            descriptor,
            python_root,
        )
        return None
    except Exception as exc:
        meta_path_container_before[:] = sys_meta_path_before
        sys.meta_path = meta_path_container_before
        _restore_tool_pack_registry(
            handlers_before,
            metadata_before,
            owners_before,
            load_errors_before,
            loaded_ids_before,
            loaded_fingerprints_before,
            python_roots_before,
            statuses_before,
            status_meta_before,
            policy_status_before,
        )
        sys.path[:] = sys_path_before
        if python_root is not None:
            _remove_failed_tool_pack_modules(
                modules_before,
                descriptor.python_package,
                python_root,
            )
        _log_exception(
            f'Unreal Editor WebUI Tool Pack "{descriptor.pack_id}" failed to load.'
        )
        return _tool_pack_diagnostic(
            descriptor,
            exc.public_error
            if isinstance(exc, _ToolPackLoadError)
            else "Tool Pack Python package failed to load; see the Unreal Log.",
            exc.reason_code
            if isinstance(exc, _ToolPackLoadError)
            else "entry_import_failed",
        )


def _conflicting_tool_pack_indexes(
    descriptors: list[ToolPackDescriptor],
) -> tuple[set[int], list[dict[str, str]]]:
    conflicts: set[int] = set()
    errors: list[dict[str, str]] = []
    fields = (
        ("pack_id", "id", False, "pack_id_conflict"),
        ("python_package", "pythonPackage top-level", True, "python_package_conflict"),
    )
    for attribute, label, top_level_only, reason_code in fields:
        groups: dict[str, list[int]] = {}
        for index, descriptor in enumerate(descriptors):
            raw_value = str(getattr(descriptor, attribute))
            value = raw_value.split(".", 1)[0] if top_level_only else raw_value
            groups.setdefault(value.casefold(), []).append(index)
        for group_value, indexes in groups.items():
            if len(indexes) < 2:
                continue
            conflicts.update(indexes)
            for index in indexes:
                descriptor = descriptors[index]
                errors.append(
                    _tool_pack_diagnostic(
                        descriptor,
                        f'Duplicate Tool Pack {label} "{group_value}"; '
                        "all conflicting Tool Packs were not loaded.",
                        reason_code,
                    )
                )

    namespace_conflicts: dict[int, set[str]] = {}
    normalized_namespaces = [
        str(descriptor.command_namespace).casefold()
        for descriptor in descriptors
    ]
    for left_index, left_namespace in enumerate(normalized_namespaces):
        for right_index in range(left_index + 1, len(normalized_namespaces)):
            right_namespace = normalized_namespaces[right_index]
            if not (
                left_namespace == right_namespace
                or left_namespace.startswith(f"{right_namespace}.")
                or right_namespace.startswith(f"{left_namespace}.")
            ):
                continue
            namespace_conflicts.setdefault(left_index, set()).add(right_namespace)
            namespace_conflicts.setdefault(right_index, set()).add(left_namespace)

    conflicts.update(namespace_conflicts)
    for index, overlapping_namespaces in sorted(namespace_conflicts.items()):
        descriptor = descriptors[index]
        namespace = normalized_namespaces[index]
        if namespace in overlapping_namespaces:
            error = (
                f'Duplicate Tool Pack commandNamespace "{namespace}"; '
                "all conflicting Tool Packs were not loaded."
            )
        else:
            overlap = sorted(overlapping_namespaces)[0]
            error = (
                f'Tool Pack commandNamespace "{descriptor.command_namespace}" overlaps '
                f'commandNamespace "{overlap}"; all conflicting Tool Packs were not loaded.'
            )
        errors.append(
            _tool_pack_diagnostic(
                descriptor,
                error,
                "command_namespace_conflict",
            )
        )
    return conflicts, errors


def _tool_pack_descriptor_sort_key(
    descriptor: ToolPackDescriptor,
) -> tuple[str, ...]:
    return (
        descriptor.pack_id.casefold(),
        descriptor.pack_id,
        descriptor.plugin_name.casefold(),
        descriptor.plugin_name,
        descriptor.python_package.casefold(),
        descriptor.python_package,
        descriptor.command_namespace.casefold(),
        descriptor.command_namespace,
        str(descriptor.python_root).casefold(),
        str(descriptor.python_root),
    )


def _loaded_tool_pack_conflict_error(
    descriptor: ToolPackDescriptor,
    fingerprint: _LoadedToolPackFingerprint,
) -> str | None:
    for loaded in sorted(
        _LOADED_TOOL_PACK_FINGERPRINTS.values(),
        key=lambda item: (item.pack_id.casefold(), item.pack_id),
    ):
        if fingerprint.top_level_python_package == loaded.top_level_python_package:
            return (
                f'Tool Pack pythonPackage top-level "{fingerprint.top_level_python_package}" '
                f'is already owned by loaded Tool Pack "{loaded.pack_id}"; '
                "the new Tool Pack was not loaded."
            )
        if _tool_pack_namespaces_overlap(
            descriptor.command_namespace,
            loaded.command_namespace,
        ):
            return (
                f'Tool Pack commandNamespace "{descriptor.command_namespace}" overlaps '
                f'the loaded Tool Pack "{loaded.pack_id}" commandNamespace '
                f'"{loaded.command_namespace}"; the new Tool Pack was not loaded.'
            )
    return None


def _set_tool_pack_policy_status(
    *,
    enforced: bool,
    state: str,
    reason_codes: list[str] | tuple[str, ...] = (),
) -> None:
    _TOOL_PACK_POLICY_STATUS.clear()
    _TOOL_PACK_POLICY_STATUS.update(
        {
            "enforced": bool(enforced),
            "state": state if state in {"accepted", "disabled", "rejected"} else "rejected",
            "reasonCodes": _public_tool_pack_reason_codes(reason_codes),
        }
    )


def _load_runtime_tool_pack_policy() -> tuple[ToolPackPolicy | None, str | None]:
    try:
        paths = getattr(unreal, "Paths", None)
        project_dir = paths.project_dir() if paths is not None else ""
        if not isinstance(project_dir, str) or not project_dir.strip():
            raise ToolPackIntegrityError(
                "trust_policy_invalid",
                "Project directory is unavailable for Tool Pack policy discovery.",
            )
        policy = load_project_tool_pack_policy(project_dir)
        if policy is None:
            _set_tool_pack_policy_status(enforced=False, state="disabled")
        else:
            _set_tool_pack_policy_status(enforced=True, state="accepted")
        return policy, None
    except ToolPackIntegrityError:
        _set_tool_pack_policy_status(
            enforced=True,
            state="rejected",
            reason_codes=["trust_policy_invalid"],
        )
        return None, "trust_policy_invalid"
    except Exception:
        _log_exception("Unreal Editor WebUI could not read the Tool Pack project policy.")
        _set_tool_pack_policy_status(
            enforced=True,
            state="rejected",
            reason_codes=["trust_policy_invalid"],
        )
        return None, "trust_policy_invalid"


def _tool_pack_policy_rejection(
    descriptor: ToolPackDescriptor,
    policy: ToolPackPolicy,
) -> str | None:
    entry = policy.by_pack_id.get(descriptor.pack_id)
    if entry is None:
        return "trust_anchor_missing"
    if entry.plugin_version != descriptor.plugin_version:
        return "trusted_plugin_version_mismatch"
    if entry.required_core_api != descriptor.required_core_api:
        return "trusted_core_api_mismatch"
    try:
        plugin_directory = Path(descriptor.python_root).resolve(strict=True).parent.parent
        payload_sha256 = compute_tool_pack_payload_sha256(plugin_directory)
    except ToolPackIntegrityError:
        return "trusted_payload_unverifiable"
    except (OSError, RuntimeError, ValueError):
        return "trusted_payload_unverifiable"
    if payload_sha256 != entry.payload_sha256:
        return "trusted_payload_mismatch"
    return None


def load_tool_packs(
    descriptors: list[ToolPackDescriptor] | None = None,
    discovery_errors: list[dict[str, str]] | None = None,
) -> None:
    """Load discovered Tool Packs once, preserving healthy registry state."""

    if descriptors is None:
        descriptors, discovered_errors = discover_tool_packs(SDK_API_VERSION)
        if discovery_errors is None:
            discovery_errors = discovered_errors
        else:
            discovery_errors = [*discovery_errors, *discovered_errors]

    project_policy, policy_error = _load_runtime_tool_pack_policy()

    tool_pack_errors: list[dict[str, str]] = []
    status_updates: list[dict[str, Any]] = []
    omitted_status_count = 0

    descriptor_count = len(descriptors)
    if descriptor_count > MAX_TOOL_PACK_DESCRIPTOR_COUNT:
        ordered_descriptors = nsmallest(
            MAX_TOOL_PACK_DESCRIPTOR_COUNT,
            descriptors,
            key=_tool_pack_descriptor_sort_key,
        )
        omitted_descriptor_count = descriptor_count - len(ordered_descriptors)
        omitted_status_count += omitted_descriptor_count
        tool_pack_errors.append(
            {
                "module": "plugin:discovery",
                "error": (
                    f"Tool Pack descriptor processing is limited to "
                    f"{MAX_TOOL_PACK_DESCRIPTOR_COUNT} entries; "
                    f"{omitted_descriptor_count} additional entries were not processed."
                ),
            }
        )
    else:
        ordered_descriptors = sorted(
            descriptors,
            key=_tool_pack_descriptor_sort_key,
        )

    if project_policy is not None:
        installed_ids = {descriptor.pack_id for descriptor in ordered_descriptors}
        if any(entry.pack_id not in installed_ids for entry in project_policy.entries):
            _set_tool_pack_policy_status(
                enforced=True,
                state="rejected",
                reason_codes=["trusted_pack_missing"],
            )

    processed_discovery_errors = 0
    omitted_discovery_errors = 0
    for diagnostic in discovery_errors or []:
        module = diagnostic.get("module") if isinstance(diagnostic, dict) else None
        error = diagnostic.get("error") if isinstance(diagnostic, dict) else None
        if isinstance(module, str) and module.strip() and isinstance(error, str) and error.strip():
            if processed_discovery_errors >= MAX_TOOL_PACK_DISCOVERY_ERROR_COUNT:
                omitted_discovery_errors += 1
                if _tool_pack_discovery_error_status(diagnostic) is not None:
                    omitted_status_count += 1
                continue
            processed_discovery_errors += 1
            tool_pack_errors.append({"module": module[:144], "error": error[:512]})
            status = _tool_pack_discovery_error_status(diagnostic)
            if status is not None:
                status_updates.append(status)

    if omitted_discovery_errors:
        tool_pack_errors.append(
            {
                "module": "plugin:discovery",
                "error": (
                    f"Tool Pack discovery diagnostics are limited to "
                    f"{MAX_TOOL_PACK_DISCOVERY_ERROR_COUNT} entries; "
                    f"{omitted_discovery_errors} additional diagnostics were omitted."
                ),
            }
        )

    new_descriptors: list[ToolPackDescriptor] = []
    for descriptor in ordered_descriptors:
        policy_rejection = (
            policy_error
            if policy_error is not None
            else (
                _tool_pack_policy_rejection(descriptor, project_policy)
                if project_policy is not None
                else None
            )
        )
        if policy_rejection is not None:
            _set_tool_pack_policy_status(
                enforced=True,
                state="rejected",
                reason_codes=[
                    *_TOOL_PACK_POLICY_STATUS.get("reasonCodes", []),
                    policy_rejection,
                ],
            )
            tool_pack_errors.append(
                _tool_pack_diagnostic(
                    descriptor,
                    "Tool Pack was rejected by the project trust policy.",
                    policy_rejection,
                )
            )
            status_updates.append(
                _tool_pack_status_record(
                    descriptor,
                    "rejected",
                    reason_codes=[policy_rejection],
                )
            )
            continue
        fingerprint = _tool_pack_fingerprint(descriptor)
        loaded_fingerprint = _LOADED_TOOL_PACK_FINGERPRINTS.get(descriptor.pack_id)
        loaded_id_present = descriptor.pack_id in _LOADED_TOOL_PACK_IDS
        if loaded_fingerprint is not None or loaded_id_present:
            if (
                loaded_fingerprint is not None
                and loaded_id_present
                and fingerprint == loaded_fingerprint
            ):
                status_updates.append(
                    _tool_pack_status_record(
                        descriptor,
                        "loaded",
                        _tool_pack_owned_commands(descriptor.pack_id),
                    )
                )
            else:
                tool_pack_errors.append(
                    _tool_pack_diagnostic(
                        descriptor,
                        f'Tool Pack id "{descriptor.pack_id}" is already loaded with a '
                        "different descriptor; the new Tool Pack was not loaded.",
                        "pack_id_conflict",
                    )
                )
                status_updates.append(
                    _tool_pack_status_record(
                        descriptor,
                        "rejected",
                        reason_codes=["pack_id_conflict"],
                    )
                )
            continue

        loaded_conflict = _loaded_tool_pack_conflict_error(descriptor, fingerprint)
        if loaded_conflict is not None:
            tool_pack_errors.append(
                _tool_pack_diagnostic(
                    descriptor,
                    loaded_conflict,
                    "tool_pack_conflict",
                )
            )
            status_updates.append(
                _tool_pack_status_record(
                    descriptor,
                    "rejected",
                    reason_codes=["tool_pack_conflict"],
                )
            )
            continue
        new_descriptors.append(descriptor)

    conflicting_indexes, conflict_errors = _conflicting_tool_pack_indexes(new_descriptors)
    tool_pack_errors.extend(conflict_errors)
    for index, descriptor in enumerate(new_descriptors):
        if index in conflicting_indexes:
            conflict_reason_codes = [
                item.get("reasonCode", "tool_pack_conflict")
                for item in conflict_errors
                if item.get("module") == f"toolpack:{descriptor.pack_id}"[:144]
            ]
            status_updates.append(
                _tool_pack_status_record(
                    descriptor,
                    "rejected",
                    reason_codes=conflict_reason_codes or ["tool_pack_conflict"],
                )
            )
            continue
        error = _load_tool_pack_descriptor(descriptor)
        if error is not None:
            tool_pack_errors.append(error)
            status_updates.append(
                _tool_pack_status_record(
                    descriptor,
                    "rejected",
                    reason_codes=[error.get("reasonCode", "entry_import_failed")],
                )
            )
        else:
            status_updates.append(
                _tool_pack_status_record(
                    descriptor,
                    "loaded",
                    _tool_pack_owned_commands(descriptor.pack_id),
                )
            )

    _publish_tool_pack_statuses(status_updates, omitted_status_count)

    tool_pack_errors.sort(key=lambda item: (item["module"].casefold(), item["error"]))
    for diagnostic in tool_pack_errors:
        _append_command_load_error(diagnostic["module"], diagnostic["error"])


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
    except Exception:
        _log_exception("Unreal Editor WebUI command inspection failed.")
        return _error(
            request_id,
            "handler_exception",
            GENERIC_HANDLER_ERROR_MESSAGE,
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
    except Exception:
        _log_exception("Unreal Editor WebUI command handler failed.")
        return _error(
            request_id,
            "handler_exception",
            GENERIC_HANDLER_ERROR_MESSAGE,
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
    except Exception:
        _log_exception("Unreal Editor WebUI cooperative command start failed.")
        return _error(request_id, "handler_exception", GENERIC_HANDLER_ERROR_MESSAGE)


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
        except Exception:
            COOPERATIVE_JOBS.pop(task_id, None)
            _close_cooperative_job(job)
            _log_exception("Unreal Editor WebUI cooperative command failed.")
            return _error(job.request_id, "handler_exception", GENERIC_HANDLER_ERROR_MESSAGE)

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
    except Exception:
        job = COOPERATIVE_JOBS.pop(task_id, None) if task_id else None
        if job is not None:
            _close_cooperative_job(job)
        _log_exception("Unreal Editor WebUI cooperative command dispatch failed.")
        return _error(request_id, "handler_exception", GENERIC_HANDLER_ERROR_MESSAGE)


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
    except Exception:
        _log_exception("Unreal Editor WebUI cooperative cleanup failed.")
        return _error(request_id, "handler_exception", GENERIC_HANDLER_ERROR_MESSAGE)


with _registration_context("core"):
    load_command_modules()
load_tool_packs()
