from __future__ import annotations

import json
import math
import os
import re
import stat
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Iterable

from unreal_editor_webui_toolpack_integrity import (
    ToolPackIntegrityError,
    compute_bounded_directory_sha256,
)


TOOL_PACK_SCHEMA_VERSION = 2
SUPPORTED_TOOL_PACK_SCHEMA_VERSIONS = frozenset({1, 2})
MAX_DESCRIPTOR_BYTES = 1024 * 1024
MAX_DESCRIPTOR_DEPTH = 64
MAX_MANIFEST_BYTES = 64 * 1024
MAX_MANIFEST_DEPTH = 8
MAX_TREE_ENTRIES = 10000
MAX_TREE_DEPTH = 64
MAX_IDENTIFIER_LENGTH = 128
MAX_PACKAGE_LENGTH = 256
MAX_COMMAND_NAME_LENGTH = 256
MAX_ENTRY_MODULE_COUNT = 32
MAX_CORE_API_VERSION = 2_147_483_647
MANIFEST_RELATIVE_PATH = Path("Content") / "UnrealEditorWebUI" / "ToolPack.json"
PYTHON_ROOT_RELATIVE_PATH = Path("Content") / "Python"
MANIFEST_V1_KEYS = {
    "schemaVersion",
    "id",
    "requiredCoreApi",
    "pythonPackage",
    "commandNamespace",
}
MANIFEST_V2_KEYS = MANIFEST_V1_KEYS | {"dependencyPolicy", "entryModules"}
PACK_ID_PATTERN = re.compile(
    r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+\Z"
)
PYTHON_PACKAGE_PATTERN = re.compile(r"[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*\Z")
ENTRY_MODULE_PATTERN = re.compile(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\Z")
COMMAND_NAMESPACE_PATTERN = re.compile(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\Z")
COMMAND_NAME_PATTERN = re.compile(
    r"[a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*)+\Z"
)
PLUGIN_NAME_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}\Z")
PLUGIN_VERSION_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}\Z")
SAFE_LABEL_PATTERN = re.compile(r"[^A-Za-z0-9_.-]+")
CORE_PLUGIN_NAME = "UnrealEditorWebUI"
RESERVED_COMMAND_NAMESPACES = frozenset({"asset", "demo", "editor", "system"})
SUPPORTED_PURE_PYTHON_DEPENDENCY_POLICIES = frozenset({"none", "vendored"})
SUPPORTED_NATIVE_DEPENDENCY_POLICIES = frozenset({"none", "outOfProcess"})
STARTUP_HOOK_NAME = "init_unreal.py"
SHA256_PATTERN = re.compile(r"sha256:[0-9a-f]{64}\Z")


@dataclass(frozen=True)
class ToolPackDependencyPolicy:
    pure_python: str
    pure_python_tree_sha256: str | None
    native: str


@dataclass(frozen=True)
class ToolPackDescriptor:
    plugin_name: str
    plugin_version: str
    pack_id: str
    required_core_api: int
    python_package: str
    command_namespace: str
    python_root: Path
    schema_version: int = 1
    entry_modules: tuple[str, ...] = ()
    dependency_policy: ToolPackDependencyPolicy | None = None


@dataclass(frozen=True)
class ToolPackValidationIssue:
    reason_code: str
    plugin_name: str
    message: str


@dataclass(frozen=True)
class ToolPackDirectoryValidation:
    state: str
    plugin_name: str
    descriptor: ToolPackDescriptor | None
    issues: tuple[ToolPackValidationIssue, ...]

    @property
    def valid(self) -> bool:
        return self.state == "valid" and not self.issues and self.descriptor is not None


@dataclass(frozen=True)
class ToolPackValidationReport:
    directory_results: tuple[ToolPackDirectoryValidation, ...]
    candidate_descriptors: tuple[ToolPackDescriptor, ...]
    descriptors: tuple[ToolPackDescriptor, ...]
    issues: tuple[ToolPackValidationIssue, ...]

    @property
    def valid(self) -> bool:
        return not self.issues and all(
            result.state == "valid" for result in self.directory_results
        )


class _ValidationFailure(ValueError):
    def __init__(self, reason_code: str, message: str) -> None:
        super().__init__(message)
        self.reason_code = reason_code
        self.message = message


def _safe_label(value: Any, fallback: str = "unknown") -> str:
    text = str(value).strip() if value is not None else ""
    text = SAFE_LABEL_PATTERN.sub("-", text).strip("-.")[:MAX_IDENTIFIER_LENGTH]
    return text or fallback


def _diagnostic(
    module: str,
    error: str,
    reason_code: str = "validation_failed",
) -> dict[str, str]:
    return {
        "module": module[: MAX_IDENTIFIER_LENGTH + 16],
        "error": error[:512],
        "reasonCode": reason_code[:64],
    }


def _issue_sort_key(issue: ToolPackValidationIssue) -> tuple[str, str, str, str]:
    return (
        issue.plugin_name.casefold(),
        issue.plugin_name,
        issue.reason_code,
        issue.message,
    )


def _descriptor_sort_key(
    descriptor: ToolPackDescriptor,
) -> tuple[str, str, str, str, str, str]:
    return (
        descriptor.pack_id.casefold(),
        descriptor.pack_id,
        descriptor.plugin_name.casefold(),
        descriptor.plugin_name,
        descriptor.python_package,
        descriptor.command_namespace,
    )


def _is_reparse_stat(path_stat: os.stat_result) -> bool:
    if stat.S_ISLNK(path_stat.st_mode):
        return True
    attributes = getattr(path_stat, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def _assert_safe_tree(plugin_directory: Path) -> None:
    try:
        root_stat = plugin_directory.lstat()
    except OSError as exc:
        raise _ValidationFailure(
            "plugin_directory_unreadable",
            "Plugin directory could not be inspected.",
        ) from exc
    if _is_reparse_stat(root_stat):
        raise _ValidationFailure(
            "path_reparse_point",
            "Plugin directory and Tool Pack files must not be reparse points.",
        )
    if not stat.S_ISDIR(root_stat.st_mode):
        raise _ValidationFailure(
            "plugin_directory_invalid",
            "Plugin directory must be an existing directory.",
        )

    pending = [(plugin_directory, 0)]
    entry_count = 0
    while pending:
        directory, depth = pending.pop()
        try:
            with os.scandir(directory) as iterator:
                entries = []
                for entry in iterator:
                    entry_count += 1
                    if entry_count > MAX_TREE_ENTRIES:
                        raise _ValidationFailure(
                            "scan_limit_exceeded",
                            "Plugin directory exceeds the bounded validation scan limits.",
                        )
                    entries.append(entry)
                entries.sort(key=lambda item: (item.name.casefold(), item.name))
        except OSError as exc:
            raise _ValidationFailure(
                "plugin_directory_unreadable",
                "Plugin directory could not be inspected.",
            ) from exc
        for entry in entries:
            try:
                entry_stat = entry.stat(follow_symlinks=False)
            except OSError as exc:
                raise _ValidationFailure(
                    "plugin_directory_unreadable",
                    "Plugin directory could not be inspected.",
                ) from exc
            if _is_reparse_stat(entry_stat):
                raise _ValidationFailure(
                    "path_reparse_point",
                    "Plugin directory and Tool Pack files must not be reparse points.",
                )
            if stat.S_ISDIR(entry_stat.st_mode):
                child_depth = depth + 1
                if child_depth > MAX_TREE_DEPTH:
                    raise _ValidationFailure(
                        "scan_limit_exceeded",
                        "Plugin directory exceeds the bounded validation scan limits.",
                    )
                pending.append((Path(entry.path), child_depth))


def _validate_raw_json_depth(
    document: str,
    max_depth: int,
    reason_code: str,
    label: str,
) -> None:
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
            if depth > max_depth:
                raise _ValidationFailure(
                    reason_code,
                    f"{label} exceeds the supported nesting depth.",
                )
        elif character in "]}":
            depth = max(0, depth - 1)


def _read_strict_json(
    path: Path,
    *,
    label: str,
    max_bytes: int,
    max_depth: int,
    invalid_code: str,
    duplicate_code: str,
) -> Any:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise _ValidationFailure(invalid_code, f"{label} could not be read.") from exc
    if not raw or len(raw) > max_bytes:
        raise _ValidationFailure(
            invalid_code,
            f"{label} must be non-empty and no larger than {max_bytes} bytes.",
        )
    try:
        document = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise _ValidationFailure(
            invalid_code,
            f"{label} must use strict UTF-8 JSON.",
        ) from exc

    _validate_raw_json_depth(document, max_depth, invalid_code, label)

    def closed_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise _ValidationFailure(
                    duplicate_code,
                    f"{label} contains a duplicate decoded field.",
                )
            value[key] = item
        return value

    def invalid_constant(_value: str) -> None:
        raise _ValidationFailure(
            invalid_code,
            f"{label} must use strict UTF-8 JSON.",
        )

    def assert_finite_numbers(value: Any) -> None:
        if isinstance(value, float) and not math.isfinite(value):
            raise _ValidationFailure(
                invalid_code,
                f"{label} must use strict UTF-8 JSON.",
            )
        if isinstance(value, dict):
            for item in value.values():
                assert_finite_numbers(item)
        elif isinstance(value, list):
            for item in value:
                assert_finite_numbers(item)

    try:
        value = json.loads(
            document,
            object_pairs_hook=closed_object,
            parse_constant=invalid_constant,
        )
        assert_finite_numbers(value)
        return value
    except _ValidationFailure:
        raise
    except (json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise _ValidationFailure(
            invalid_code,
            f"{label} must use strict UTF-8 JSON.",
        ) from exc


def _exact_field(record: dict[str, Any], field: str, reason_code: str) -> bool:
    matching = [key for key in record if key.casefold() == field.casefold()]
    if len(matching) > 1 or (matching and matching[0] != field):
        raise _ValidationFailure(
            reason_code,
            f'Plugin descriptor contains ambiguous field casing for "{field}".',
        )
    return bool(matching)


def _require_manifest_string(
    manifest: dict[str, Any],
    field: str,
    pattern: re.Pattern[str],
    max_length: int,
    reason_code: str,
) -> str:
    value = manifest.get(field)
    if (
        not isinstance(value, str)
        or not value
        or len(value) > max_length
        or pattern.fullmatch(value) is None
    ):
        raise _ValidationFailure(
            reason_code,
            f'Tool Pack manifest field "{field}" is invalid.',
        )
    return value


def _resolve_child(root: Path, child: Path) -> Path:
    try:
        canonical_root = root.resolve(strict=True)
        canonical_child = child.resolve(strict=True)
        canonical_child.relative_to(canonical_root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise _ValidationFailure(
            "path_escape",
            "Tool Pack files must stay inside the plugin directory.",
        ) from exc
    return canonical_child


def _namespace_overlaps(left: str, right: str) -> bool:
    left_key = left.casefold()
    right_key = right.casefold()
    return (
        left_key == right_key
        or left_key.startswith(right_key + ".")
        or right_key.startswith(left_key + ".")
    )


def _matching_children(parent: Path, name: str) -> list[Path]:
    try:
        return sorted(
            (entry for entry in parent.iterdir() if entry.name.casefold() == name.casefold()),
            key=lambda entry: (entry.name.casefold(), entry.name),
        )
    except OSError as exc:
        raise _ValidationFailure(
            "entry_module_missing",
            "Tool Pack entry module path could not be inspected.",
        ) from exc


def _require_exact_child(parent: Path, name: str, *, directory: bool) -> Path:
    matches = _matching_children(parent, name)
    if len(matches) != 1 or matches[0].name != name:
        raise _ValidationFailure(
            "entry_module_ambiguous" if len(matches) > 1 else "entry_module_missing",
            "Tool Pack entry module must resolve to one exact internal Python module.",
        )
    child = matches[0]
    if (directory and not child.is_dir()) or (not directory and not child.is_file()):
        raise _ValidationFailure(
            "entry_module_missing",
            "Tool Pack entry module must resolve to one exact internal Python module.",
        )
    return child


def _resolve_entry_module(package_directory: Path, entry_module: str) -> None:
    parts = entry_module.split(".")
    current = package_directory
    for segment in parts[:-1]:
        current = _require_exact_child(current, segment, directory=True)
        _require_exact_child(current, "__init__.py", directory=False)

    final = parts[-1]
    module_matches = _matching_children(current, f"{final}.py")
    package_matches = _matching_children(current, final)
    exact_module = [path for path in module_matches if path.name == f"{final}.py" and path.is_file()]
    exact_package = [path for path in package_matches if path.name == final and path.is_dir()]
    if len(module_matches) > 1 or len(package_matches) > 1:
        raise _ValidationFailure(
            "entry_module_ambiguous",
            "Tool Pack entry module path is ambiguous on a portable filesystem.",
        )
    if module_matches and not exact_module or package_matches and not exact_package:
        raise _ValidationFailure(
            "entry_module_missing",
            "Tool Pack entry module path must use exact portable casing.",
        )
    if bool(exact_module) == bool(exact_package):
        raise _ValidationFailure(
            "entry_module_ambiguous" if exact_module else "entry_module_missing",
            "Tool Pack entry module must resolve to exactly one module file or package.",
        )
    if exact_package:
        _require_exact_child(exact_package[0], "__init__.py", directory=False)


def _validate_entry_modules(
    manifest: dict[str, Any],
    package_directory: Path,
) -> tuple[str, ...]:
    value = manifest.get("entryModules")
    if (
        not isinstance(value, list)
        or not value
        or len(value) > MAX_ENTRY_MODULE_COUNT
        or any(not isinstance(item, str) for item in value)
    ):
        raise _ValidationFailure(
            "entry_modules_invalid",
            f'Tool Pack manifest field "entryModules" must contain 1-{MAX_ENTRY_MODULE_COUNT} strings.',
        )
    normalized: list[str] = []
    seen: set[str] = set()
    for item in value:
        if (
            not item
            or len(item) > MAX_PACKAGE_LENGTH
            or ENTRY_MODULE_PATTERN.fullmatch(item) is None
            or item == "__init__"
            or item.endswith(".__init__")
        ):
            raise _ValidationFailure(
                "entry_module_invalid",
                "Tool Pack entryModules must use bounded relative dotted module names.",
            )
        key = item.casefold()
        if key in seen:
            raise _ValidationFailure(
                "entry_module_duplicate",
                "Tool Pack entryModules must not contain portable duplicates.",
            )
        seen.add(key)
        _resolve_entry_module(package_directory, item)
        normalized.append(item)
    return tuple(sorted(normalized))


def _validate_dependency_policy(
    manifest: dict[str, Any],
    package_directory: Path,
) -> ToolPackDependencyPolicy:
    value = manifest.get("dependencyPolicy")
    if not isinstance(value, dict) or set(value) != {"native", "purePython"}:
        raise _ValidationFailure(
            "dependency_policy_invalid",
            'Tool Pack manifest field "dependencyPolicy" must use the closed schema v2 contract.',
        )
    pure_python_value = value.get("purePython")
    native_value = value.get("native")
    if (
        not isinstance(pure_python_value, dict)
        or set(pure_python_value) != {"mode", "treeSha256"}
        or not isinstance(native_value, dict)
        or set(native_value) != {"mode"}
    ):
        raise _ValidationFailure(
            "dependency_policy_invalid",
            "Tool Pack dependencyPolicy contains an unsupported closed entry.",
        )
    pure_python = pure_python_value.get("mode")
    pure_python_tree_sha256 = pure_python_value.get("treeSha256")
    native = native_value.get("mode")
    if (
        not isinstance(pure_python, str)
        or pure_python not in SUPPORTED_PURE_PYTHON_DEPENDENCY_POLICIES
        or not isinstance(native, str)
        or native not in SUPPORTED_NATIVE_DEPENDENCY_POLICIES
        or (
            pure_python == "none"
            and pure_python_tree_sha256 is not None
        )
        or (
            pure_python == "vendored"
            and (
                not isinstance(pure_python_tree_sha256, str)
                or SHA256_PATTERN.fullmatch(pure_python_tree_sha256) is None
            )
        )
    ):
        raise _ValidationFailure(
            "dependency_policy_invalid",
            "Tool Pack dependencyPolicy contains an unsupported mode or hash contract.",
        )
    if pure_python == "vendored":
        vendor_directory = package_directory / "_vendor"
        if not vendor_directory.is_dir() or not (vendor_directory / "__init__.py").is_file():
            raise _ValidationFailure(
                "vendored_dependencies_missing",
                "Vendored pure-Python dependencies require an internal _vendor package.",
            )
        try:
            actual_tree_sha256 = compute_bounded_directory_sha256(vendor_directory)
        except ToolPackIntegrityError as exc:
            raise _ValidationFailure(exc.reason_code, exc.message) from exc
        if actual_tree_sha256 != pure_python_tree_sha256:
            raise _ValidationFailure(
                "dependency_hash_mismatch",
                "Vendored pure-Python dependencies do not match dependencyPolicy.treeSha256.",
            )
    else:
        try:
            undeclared_vendor_entries = [
                entry
                for entry in package_directory.iterdir()
                if entry.name.casefold() == "_vendor"
            ]
        except OSError as exc:
            raise _ValidationFailure(
                "dependency_policy_invalid",
                "Tool Pack dependency payload could not be inspected.",
            ) from exc
        if undeclared_vendor_entries:
            raise _ValidationFailure(
                "unlocked_vendored_dependencies",
                "dependencyPolicy purePython none must not contain an unlocked _vendor payload.",
            )

    pending = [package_directory]
    while pending:
        current = pending.pop()
        try:
            entries = list(current.iterdir())
        except OSError as exc:
            raise _ValidationFailure(
                "dependency_policy_invalid",
                "Tool Pack dependency payload could not be inspected.",
            ) from exc
        for entry in entries:
            if entry.is_dir():
                pending.append(entry)
            elif entry.is_file() and entry.suffix.casefold() in {".pyd", ".so", ".dylib"}:
                raise _ValidationFailure(
                    "in_process_native_dependency_unsupported",
                    "In-process Python native dependencies are unsupported by schema v2.",
                )
    return ToolPackDependencyPolicy(
        pure_python=pure_python,
        pure_python_tree_sha256=(
            pure_python_tree_sha256
            if isinstance(pure_python_tree_sha256, str)
            else None
        ),
        native=native,
    )


def _reject_startup_hook(python_root: Path) -> None:
    try:
        matches = [
            entry
            for entry in python_root.iterdir()
            if entry.name.casefold() == STARTUP_HOOK_NAME.casefold()
        ]
    except OSError as exc:
        raise _ValidationFailure(
            "python_root_missing",
            "Tool Pack Content/Python directory could not be inspected.",
        ) from exc
    if matches:
        raise _ValidationFailure(
            "startup_hook_forbidden",
            "Tool Packs must not contain Content/Python/init_unreal.py startup hooks.",
        )


def _validate_tool_pack_directory(
    plugin_directory_value: str | os.PathLike[str],
    core_api_version: int,
    allow_missing_manifest: bool,
) -> ToolPackDirectoryValidation:
    plugin_directory = Path(plugin_directory_value)
    plugin_name = _safe_label(plugin_directory.name, fallback="unknown-plugin")
    manifest_candidate = plugin_directory / MANIFEST_RELATIVE_PATH

    try:
        if not plugin_directory.exists():
            raise _ValidationFailure(
                "plugin_directory_invalid",
                "Plugin directory must be an existing directory.",
            )
        try:
            manifest_exists = os.path.lexists(manifest_candidate)
        except OSError as exc:
            raise _ValidationFailure(
                "plugin_directory_unreadable",
                "Plugin directory could not be inspected.",
            ) from exc
        if allow_missing_manifest and not manifest_exists:
            return ToolPackDirectoryValidation(
                state="not_tool_pack",
                plugin_name=plugin_name,
                descriptor=None,
                issues=(),
            )

        _assert_safe_tree(plugin_directory)
        descriptor_entries = sorted(
            (
                path
                for path in plugin_directory.iterdir()
                if path.name.casefold().endswith(".uplugin")
            ),
            key=lambda path: (path.name.casefold(), path.name),
        )
        descriptor_files = [path for path in descriptor_entries if path.is_file()]
        if len(descriptor_entries) != 1 or len(descriptor_files) != 1:
            raise _ValidationFailure(
                "plugin_descriptor_count",
                "Plugin directory must contain exactly one regular root .uplugin descriptor.",
            )

        descriptor_path = descriptor_files[0]
        plugin_name = descriptor_path.stem
        if (
            PLUGIN_NAME_PATTERN.fullmatch(plugin_name) is None
            or plugin_name.casefold() == CORE_PLUGIN_NAME.casefold()
        ):
            raise _ValidationFailure(
                "plugin_name_invalid",
                "Tool Pack plugin name is invalid or reserved.",
            )

        plugin_descriptor = _read_strict_json(
            descriptor_path,
            label="Plugin descriptor",
            max_bytes=MAX_DESCRIPTOR_BYTES,
            max_depth=MAX_DESCRIPTOR_DEPTH,
            invalid_code="plugin_descriptor_json_invalid",
            duplicate_code="plugin_descriptor_json_duplicate",
        )
        if not isinstance(plugin_descriptor, dict):
            raise _ValidationFailure(
                "plugin_descriptor_invalid",
                "Plugin descriptor must be a JSON object.",
            )
        if not _exact_field(
            plugin_descriptor,
            "VersionName",
            "plugin_descriptor_field_ambiguous",
        ):
            raise _ValidationFailure(
                "plugin_version_missing",
                "Plugin descriptor must contain VersionName.",
            )
        version_value = plugin_descriptor.get("VersionName")
        if (
            not isinstance(version_value, str)
            or PLUGIN_VERSION_PATTERN.fullmatch(version_value) is None
        ):
            raise _ValidationFailure(
                "plugin_version_invalid",
                "Plugin descriptor VersionName must be a safe 1-64 character version.",
            )
        if (
            not _exact_field(
                plugin_descriptor,
                "CanContainContent",
                "plugin_descriptor_field_ambiguous",
            )
            or plugin_descriptor.get("CanContainContent") is not True
        ):
            raise _ValidationFailure(
                "plugin_content_disabled",
                "Tool Pack host plugin must set CanContainContent to true.",
            )

        if not _exact_field(
            plugin_descriptor,
            "Plugins",
            "plugin_descriptor_field_ambiguous",
        ) or not isinstance(plugin_descriptor.get("Plugins"), list):
            raise _ValidationFailure(
                "core_dependency_missing",
                "Tool Pack must declare one enabled UnrealEditorWebUI plugin dependency.",
            )
        core_dependencies: list[dict[str, Any]] = []
        for dependency in plugin_descriptor["Plugins"]:
            if not isinstance(dependency, dict):
                raise _ValidationFailure(
                    "plugin_dependency_invalid",
                    "Plugin dependencies must be JSON objects with exact field names.",
                )
            if not _exact_field(
                dependency,
                "Name",
                "plugin_descriptor_field_ambiguous",
            ) or not isinstance(dependency.get("Name"), str):
                raise _ValidationFailure(
                    "plugin_dependency_invalid",
                    "Plugin dependencies must contain a string Name field.",
                )
            if dependency["Name"].casefold() == CORE_PLUGIN_NAME.casefold():
                core_dependencies.append(dependency)
        if not core_dependencies:
            raise _ValidationFailure(
                "core_dependency_missing",
                "Tool Pack must declare one enabled UnrealEditorWebUI plugin dependency.",
            )
        if len(core_dependencies) > 1:
            raise _ValidationFailure(
                "core_dependency_duplicate",
                "Tool Pack must not declare duplicate UnrealEditorWebUI dependencies.",
            )
        core_dependency = core_dependencies[0]
        if core_dependency.get("Name") != CORE_PLUGIN_NAME:
            raise _ValidationFailure(
                "core_dependency_name_invalid",
                "Tool Pack core dependency must use the exact UnrealEditorWebUI name.",
            )
        if (
            not _exact_field(
                core_dependency,
                "Enabled",
                "plugin_descriptor_field_ambiguous",
            )
            or core_dependency.get("Enabled") is not True
        ):
            raise _ValidationFailure(
                "core_dependency_disabled",
                "Tool Pack must declare one enabled UnrealEditorWebUI plugin dependency.",
            )

        if not manifest_candidate.is_file():
            raise _ValidationFailure(
                "manifest_missing",
                "Tool Pack manifest is missing from Content/UnrealEditorWebUI.",
            )
        manifest_path = _resolve_child(plugin_directory, manifest_candidate)
        manifest = _read_strict_json(
            manifest_path,
            label="Tool Pack manifest",
            max_bytes=MAX_MANIFEST_BYTES,
            max_depth=MAX_MANIFEST_DEPTH,
            invalid_code="manifest_json_invalid",
            duplicate_code="manifest_json_duplicate",
        )
        if not isinstance(manifest, dict):
            raise _ValidationFailure(
                "manifest_invalid",
                "Tool Pack manifest must be a JSON object.",
            )
        schema_version = manifest.get("schemaVersion")
        if (
            isinstance(schema_version, bool)
            or not isinstance(schema_version, int)
            or schema_version not in SUPPORTED_TOOL_PACK_SCHEMA_VERSIONS
        ):
            raise _ValidationFailure(
                "schema_version_unsupported",
                "Tool Pack manifest requires supported schemaVersion 1 or 2.",
            )
        expected_manifest_keys = (
            MANIFEST_V1_KEYS if schema_version == 1 else MANIFEST_V2_KEYS
        )
        if set(manifest) != expected_manifest_keys:
            raise _ValidationFailure(
                "manifest_fields_invalid",
                f"Tool Pack manifest must contain exactly the schema v{schema_version} fields.",
            )

        required_core_api = manifest.get("requiredCoreApi")
        if isinstance(required_core_api, bool) or not isinstance(required_core_api, int):
            raise _ValidationFailure(
                "core_api_invalid",
                'Tool Pack manifest field "requiredCoreApi" must be a positive integer.',
            )
        if required_core_api <= 0 or required_core_api > MAX_CORE_API_VERSION:
            raise _ValidationFailure(
                "core_api_invalid",
                'Tool Pack manifest field "requiredCoreApi" must be a bounded positive integer.',
            )
        if required_core_api != core_api_version:
            raise _ValidationFailure(
                "core_api_incompatible",
                (
                    f"Tool Pack requires core API {required_core_api}, "
                    f"but this core provides API {core_api_version}."
                ),
            )

        pack_id = _require_manifest_string(
            manifest,
            "id",
            PACK_ID_PATTERN,
            MAX_IDENTIFIER_LENGTH,
            "pack_id_invalid",
        )
        python_package = _require_manifest_string(
            manifest,
            "pythonPackage",
            PYTHON_PACKAGE_PATTERN,
            MAX_PACKAGE_LENGTH,
            "python_package_invalid",
        )
        if (
            python_package == "unreal_editor_webui"
            or python_package.startswith("unreal_editor_webui.")
            or python_package.startswith("unreal_editor_webui_")
        ):
            raise _ValidationFailure(
                "python_package_reserved",
                "Tool Pack pythonPackage uses a reserved core package name.",
            )
        command_namespace = _require_manifest_string(
            manifest,
            "commandNamespace",
            COMMAND_NAMESPACE_PATTERN,
            MAX_IDENTIFIER_LENGTH,
            "command_namespace_invalid",
        )
        if any(
            _namespace_overlaps(command_namespace, reserved)
            for reserved in RESERVED_COMMAND_NAMESPACES
        ):
            raise _ValidationFailure(
                "command_namespace_reserved",
                "Tool Pack commandNamespace overlaps a reserved core namespace.",
            )

        python_root_candidate = plugin_directory / PYTHON_ROOT_RELATIVE_PATH
        if not python_root_candidate.is_dir():
            raise _ValidationFailure(
                "python_root_missing",
                "Tool Pack Content/Python directory is missing.",
            )
        python_root = _resolve_child(plugin_directory, python_root_candidate)
        _reject_startup_hook(python_root)
        package_directory = python_root
        for segment in python_package.split("."):
            package_candidate = package_directory / segment
            if not package_candidate.is_dir():
                raise _ValidationFailure(
                    "python_package_missing",
                    "Tool Pack pythonPackage directory is missing.",
                )
            package_directory = _resolve_child(python_root, package_candidate)
            init_path = package_directory / "__init__.py"
            if not init_path.is_file():
                raise _ValidationFailure(
                    "python_init_missing",
                    "Every Tool Pack pythonPackage segment must contain __init__.py.",
                )
            _resolve_child(package_directory, init_path)

        entry_modules: tuple[str, ...] = ()
        dependency_policy: ToolPackDependencyPolicy | None = None
        if schema_version == 2:
            entry_modules = _validate_entry_modules(manifest, package_directory)
            dependency_policy = _validate_dependency_policy(
                manifest,
                package_directory,
            )

        descriptor = ToolPackDescriptor(
            plugin_name=plugin_name,
            plugin_version=version_value,
            pack_id=pack_id,
            required_core_api=required_core_api,
            python_package=python_package,
            command_namespace=command_namespace,
            python_root=python_root,
            schema_version=schema_version,
            entry_modules=entry_modules,
            dependency_policy=dependency_policy,
        )
        return ToolPackDirectoryValidation(
            state="valid",
            plugin_name=plugin_name,
            descriptor=descriptor,
            issues=(),
        )
    except _ValidationFailure as exc:
        issue = ToolPackValidationIssue(
            reason_code=exc.reason_code,
            plugin_name=_safe_label(plugin_name, fallback="unknown-plugin"),
            message=exc.message,
        )
        return ToolPackDirectoryValidation(
            state="invalid",
            plugin_name=issue.plugin_name,
            descriptor=None,
            issues=(issue,),
        )
    except (OSError, RuntimeError, ValueError):
        issue = ToolPackValidationIssue(
            reason_code="validation_failed",
            plugin_name=_safe_label(plugin_name, fallback="unknown-plugin"),
            message="Tool Pack validation failed while inspecting the plugin directory.",
        )
        return ToolPackDirectoryValidation(
            state="invalid",
            plugin_name=issue.plugin_name,
            descriptor=None,
            issues=(issue,),
        )


def validate_tool_pack_directory(
    plugin_directory: str | os.PathLike[str],
    core_api_version: int = 1,
    *,
    allow_missing_manifest: bool = False,
) -> ToolPackDirectoryValidation:
    """Validate one Tool Pack plugin directory without importing Unreal."""

    if isinstance(core_api_version, bool) or not isinstance(core_api_version, int):
        raise TypeError("core_api_version must be an integer")
    if core_api_version <= 0:
        raise ValueError("core_api_version must be positive")
    return _validate_tool_pack_directory(
        plugin_directory,
        core_api_version,
        allow_missing_manifest,
    )


def _find_conflicts(
    descriptors: tuple[ToolPackDescriptor, ...],
) -> tuple[set[int], tuple[ToolPackValidationIssue, ...]]:
    conflicted: set[int] = set()
    issues: list[ToolPackValidationIssue] = []
    issue_keys: set[tuple[int, str]] = set()

    def add(index: int, reason_code: str, message: str) -> None:
        key = (index, reason_code)
        if key in issue_keys:
            return
        issue_keys.add(key)
        conflicted.add(index)
        issues.append(
            ToolPackValidationIssue(
                reason_code=reason_code,
                plugin_name=descriptors[index].plugin_name,
                message=message,
            )
        )

    field_contracts = (
        (
            "plugin_name",
            "plugin_name_conflict",
            "Tool Pack plugin name conflicts with another input.",
        ),
        ("pack_id", "pack_id_conflict", "Tool Pack id conflicts with another input."),
    )
    for field, reason_code, message in field_contracts:
        groups: dict[str, list[int]] = {}
        for index, descriptor in enumerate(descriptors):
            value = str(getattr(descriptor, field)).casefold()
            groups.setdefault(value, []).append(index)
        for indices in groups.values():
            if len(indices) > 1:
                for index in indices:
                    add(index, reason_code, message)

    package_groups: dict[str, list[int]] = {}
    for index, descriptor in enumerate(descriptors):
        top_level_package = descriptor.python_package.split(".", 1)[0].casefold()
        package_groups.setdefault(top_level_package, []).append(index)
    for indices in package_groups.values():
        if len(indices) > 1:
            for index in indices:
                add(
                    index,
                    "python_package_conflict",
                    "Tool Pack top-level pythonPackage conflicts with another input.",
                )

    for left_index, left in enumerate(descriptors):
        for right_index in range(left_index + 1, len(descriptors)):
            right = descriptors[right_index]
            if _namespace_overlaps(left.command_namespace, right.command_namespace):
                message = "Tool Pack commandNamespace conflicts with another input."
                add(left_index, "command_namespace_conflict", message)
                add(right_index, "command_namespace_conflict", message)

    return conflicted, tuple(sorted(issues, key=_issue_sort_key))


def validate_tool_pack_directories(
    plugin_directories: Iterable[str | os.PathLike[str]],
    core_api_version: int = 1,
    *,
    allow_missing_manifest: bool = False,
) -> ToolPackValidationReport:
    """Validate multiple Tool Packs and reject every side of cross-pack conflicts."""

    results = tuple(
        validate_tool_pack_directory(
            path,
            core_api_version,
            allow_missing_manifest=allow_missing_manifest,
        )
        for path in plugin_directories
    )
    candidates = tuple(
        sorted(
            (
                result.descriptor
                for result in results
                if result.valid and result.descriptor is not None
            ),
            key=_descriptor_sort_key,
        )
    )
    conflicted, conflict_issues = _find_conflicts(candidates)
    descriptors = tuple(
        descriptor
        for index, descriptor in enumerate(candidates)
        if index not in conflicted
    )
    issues = tuple(
        sorted(
            (
                issue
                for result in results
                for issue in result.issues
            ),
            key=_issue_sort_key,
        )
    ) + conflict_issues
    issues = tuple(sorted(issues, key=_issue_sort_key))
    return ToolPackValidationReport(
        directory_results=tuple(
            sorted(
                results,
                key=lambda result: (
                    result.plugin_name.casefold(),
                    result.plugin_name,
                    result.state,
                ),
            )
        ),
        candidate_descriptors=candidates,
        descriptors=descriptors,
        issues=issues,
    )


def discover_tool_packs(
    core_api_version: int = 1,
) -> tuple[list[ToolPackDescriptor], list[dict[str, str]]]:
    """Discover and validate mounted Tool Packs through Unreal's enabled-plugin API."""

    try:
        import unreal

        plugin_library = getattr(unreal, "PluginBlueprintLibrary", None)
        if plugin_library is None:
            return [], []
        enabled_names = plugin_library.get_enabled_plugin_names()
    except Exception:
        try:
            import traceback

            unreal.log_error(
                "Unreal Editor WebUI could not query enabled plugins for Tool Pack discovery.\n"
                f"{traceback.format_exc()}"
            )
        except Exception:
            pass
        return [], [
            _diagnostic(
                "plugin:discovery",
                "Enabled Unreal plugins could not be queried; Tool Packs were not loaded.",
                "validation_failed",
            )
        ]

    descriptors: list[ToolPackDescriptor] = []
    errors: list[dict[str, str]] = []
    try:
        plugin_names = sorted(
            {str(name) for name in enabled_names if str(name).strip()},
            key=lambda name: (name.casefold(), name),
        )
    except Exception:
        try:
            import traceback

            unreal.log_error(
                "Unreal Editor WebUI received an invalid enabled-plugin list during Tool Pack discovery.\n"
                f"{traceback.format_exc()}"
            )
        except Exception:
            pass
        return [], [
            _diagnostic(
                "plugin:discovery",
                "Enabled Unreal plugins could not be enumerated; Tool Packs were not loaded.",
                "validation_failed",
            )
        ]

    for plugin_name in plugin_names:
        safe_plugin_name = _safe_label(plugin_name)
        try:
            if not bool(plugin_library.is_plugin_mounted(plugin_name)):
                continue
            base_dir_value = plugin_library.get_plugin_base_dir(plugin_name)
            if not isinstance(base_dir_value, str) or not base_dir_value.strip():
                continue
            result = validate_tool_pack_directory(
                base_dir_value,
                core_api_version,
                allow_missing_manifest=True,
            )
            if result.state == "not_tool_pack":
                continue
            if not result.valid or result.descriptor is None:
                for issue in result.issues:
                    errors.append(
                        _diagnostic(
                            f"plugin:{safe_plugin_name}",
                            f"[{issue.reason_code}] {issue.message}",
                            issue.reason_code,
                        )
                    )
                continue
            if plugin_name != result.descriptor.plugin_name:
                errors.append(
                    _diagnostic(
                        f"plugin:{safe_plugin_name}",
                        (
                            "[plugin_name_mismatch] Mounted plugin name does not match "
                            "the validated descriptor."
                        ),
                        "validation_failed",
                    )
                )
                continue
            plugin_version_value = plugin_library.get_plugin_version_name(plugin_name)
            if plugin_version_value != result.descriptor.plugin_version:
                errors.append(
                    _diagnostic(
                        f"plugin:{safe_plugin_name}",
                        (
                            "[plugin_version_mismatch] Mounted plugin VersionName does not "
                            "match the validated descriptor."
                        ),
                        "validation_failed",
                    )
                )
                continue
            descriptors.append(
                replace(
                    result.descriptor,
                    plugin_name=plugin_name,
                )
            )
        except Exception:
            errors.append(
                _diagnostic(
                    f"plugin:{safe_plugin_name}",
                    "Tool Pack discovery failed unexpectedly; see the Unreal Log.",
                    "validation_failed",
                )
            )
            try:
                import traceback

                unreal.log_error(
                    f'Unreal Editor WebUI Tool Pack discovery failed for plugin "{safe_plugin_name}".\n'
                    f"{traceback.format_exc()}"
                )
            except Exception:
                pass

    descriptors.sort(key=_descriptor_sort_key)
    conflicted, conflict_issues = _find_conflicts(tuple(descriptors))
    if conflicted:
        descriptors = [
            descriptor
            for index, descriptor in enumerate(descriptors)
            if index not in conflicted
        ]
        errors.extend(
            _diagnostic(
                f"plugin:{_safe_label(issue.plugin_name)}",
                f"[{issue.reason_code}] {issue.message}",
                issue.reason_code,
            )
            for issue in conflict_issues
        )
    errors.sort(key=lambda item: (item["module"].casefold(), item["error"]))
    return descriptors, errors


__all__ = [
    "COMMAND_NAME_PATTERN",
    "ENTRY_MODULE_PATTERN",
    "MAX_ENTRY_MODULE_COUNT",
    "MAX_COMMAND_NAME_LENGTH",
    "MAX_CORE_API_VERSION",
    "RESERVED_COMMAND_NAMESPACES",
    "SUPPORTED_TOOL_PACK_SCHEMA_VERSIONS",
    "ToolPackDependencyPolicy",
    "ToolPackDescriptor",
    "ToolPackDirectoryValidation",
    "ToolPackValidationIssue",
    "ToolPackValidationReport",
    "discover_tool_packs",
    "validate_tool_pack_directories",
    "validate_tool_pack_directory",
]
