from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


TOOL_PACK_SCHEMA_VERSION = 1
MAX_MANIFEST_BYTES = 64 * 1024
MAX_MANIFEST_DEPTH = 8
MAX_IDENTIFIER_LENGTH = 128
MAX_PACKAGE_LENGTH = 256
MANIFEST_RELATIVE_PATH = Path("Content") / "UnrealEditorWebUI" / "ToolPack.json"
PYTHON_ROOT_RELATIVE_PATH = Path("Content") / "Python"
MANIFEST_KEYS = {
    "schemaVersion",
    "id",
    "requiredCoreApi",
    "pythonPackage",
    "commandNamespace",
}
PACK_ID_PATTERN = re.compile(
    r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+\Z"
)
PYTHON_PACKAGE_PATTERN = re.compile(r"[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*\Z")
COMMAND_NAMESPACE_PATTERN = re.compile(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\Z")
SAFE_LABEL_PATTERN = re.compile(r"[^A-Za-z0-9_.-]+")


@dataclass(frozen=True)
class ToolPackDescriptor:
    plugin_name: str
    plugin_version: str
    pack_id: str
    required_core_api: int
    python_package: str
    command_namespace: str
    python_root: Path


class _ManifestError(ValueError):
    pass


def _safe_label(value: Any, fallback: str = "unknown") -> str:
    text = str(value).strip() if value is not None else ""
    text = SAFE_LABEL_PATTERN.sub("-", text).strip("-.")[:MAX_IDENTIFIER_LENGTH]
    return text or fallback


def _diagnostic(module: str, error: str) -> dict[str, str]:
    return {
        "module": module[: MAX_IDENTIFIER_LENGTH + 16],
        "error": error[:512],
    }


def _validate_raw_json_depth(document: str) -> None:
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
            if depth > MAX_MANIFEST_DEPTH:
                raise _ManifestError("Tool Pack manifest exceeds the supported nesting depth.")
        elif character in "]}":
            depth = max(0, depth - 1)


def _closed_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise _ManifestError("Tool Pack manifest contains a duplicate field.")
        value[key] = item
    return value


def _read_manifest(manifest_path: Path) -> dict[str, Any]:
    try:
        if manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
            raise _ManifestError("Tool Pack manifest exceeds the 64 KiB size limit.")
        raw = manifest_path.read_bytes()
    except _ManifestError:
        raise
    except OSError as exc:
        raise _ManifestError("Tool Pack manifest could not be read.") from exc
    if len(raw) > MAX_MANIFEST_BYTES:
        raise _ManifestError("Tool Pack manifest exceeds the 64 KiB size limit.")
    try:
        document = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise _ManifestError("Tool Pack manifest must be strict UTF-8 JSON.") from exc
    _validate_raw_json_depth(document)
    try:
        value = json.loads(document, object_pairs_hook=_closed_object)
    except _ManifestError:
        raise
    except (json.JSONDecodeError, RecursionError) as exc:
        raise _ManifestError("Tool Pack manifest must be valid JSON.") from exc
    if not isinstance(value, dict):
        raise _ManifestError("Tool Pack manifest must be a JSON object.")
    return value


def _require_string(
    manifest: dict[str, Any],
    field: str,
    pattern: re.Pattern[str],
    max_length: int,
) -> str:
    value = manifest.get(field)
    if not isinstance(value, str) or not value or len(value) > max_length or pattern.fullmatch(value) is None:
        raise _ManifestError(f'Tool Pack manifest field "{field}" is invalid.')
    return value


def _resolve_child(root: Path, child: Path) -> Path:
    try:
        canonical_root = root.resolve(strict=True)
        canonical_child = child.resolve(strict=True)
        canonical_child.relative_to(canonical_root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise _ManifestError("Tool Pack files must stay inside the enabled plugin directory.") from exc
    return canonical_child


def _descriptor_from_plugin(
    plugin_library: Any,
    plugin_name: str,
    core_api_version: int,
) -> ToolPackDescriptor | None:
    base_dir_value = plugin_library.get_plugin_base_dir(plugin_name)
    if not isinstance(base_dir_value, str) or not base_dir_value.strip():
        return None

    base_dir = Path(base_dir_value)
    manifest_candidate = base_dir / MANIFEST_RELATIVE_PATH
    try:
        if not manifest_candidate.is_file():
            return None
    except OSError:
        return None

    manifest_path = _resolve_child(base_dir, manifest_candidate)
    manifest = _read_manifest(manifest_path)
    if set(manifest) != MANIFEST_KEYS:
        raise _ManifestError("Tool Pack manifest must contain exactly the schema v1 fields.")

    schema_version = manifest.get("schemaVersion")
    if isinstance(schema_version, bool) or not isinstance(schema_version, int) or schema_version != TOOL_PACK_SCHEMA_VERSION:
        raise _ManifestError("Tool Pack manifest requires schemaVersion 1.")

    required_core_api = manifest.get("requiredCoreApi")
    if isinstance(required_core_api, bool) or not isinstance(required_core_api, int) or required_core_api <= 0:
        raise _ManifestError('Tool Pack manifest field "requiredCoreApi" must be a positive integer.')
    if required_core_api != core_api_version:
        raise _ManifestError(
            f"Tool Pack requires core API {required_core_api}, but this core provides API {core_api_version}."
        )

    pack_id = _require_string(manifest, "id", PACK_ID_PATTERN, MAX_IDENTIFIER_LENGTH)
    python_package = _require_string(
        manifest,
        "pythonPackage",
        PYTHON_PACKAGE_PATTERN,
        MAX_PACKAGE_LENGTH,
    )
    if (
        python_package == "unreal_editor_webui"
        or python_package.startswith("unreal_editor_webui.")
        or python_package.startswith("unreal_editor_webui_")
    ):
        raise _ManifestError("Tool Pack pythonPackage uses a reserved core package name.")
    command_namespace = _require_string(
        manifest,
        "commandNamespace",
        COMMAND_NAMESPACE_PATTERN,
        MAX_IDENTIFIER_LENGTH,
    )

    python_root = _resolve_child(base_dir, base_dir / PYTHON_ROOT_RELATIVE_PATH)
    package_directory = _resolve_child(
        python_root,
        python_root.joinpath(*python_package.split(".")),
    )
    if not package_directory.is_dir() or not (package_directory / "__init__.py").is_file():
        raise _ManifestError("Tool Pack pythonPackage must name a real package containing __init__.py.")

    plugin_version_value = plugin_library.get_plugin_version_name(plugin_name)
    plugin_version = _safe_label(plugin_version_value, fallback="unknown")
    return ToolPackDescriptor(
        plugin_name=plugin_name,
        plugin_version=plugin_version,
        pack_id=pack_id,
        required_core_api=required_core_api,
        python_package=python_package,
        command_namespace=command_namespace,
        python_root=python_root,
    )


def discover_tool_packs(
    core_api_version: int = 1,
) -> tuple[list[ToolPackDescriptor], list[dict[str, str]]]:
    """Discover mounted Tool Packs through Unreal's enabled-plugin API."""

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
            )
        ]
    for plugin_name in plugin_names:
        safe_plugin_name = _safe_label(plugin_name)
        try:
            if not bool(plugin_library.is_plugin_mounted(plugin_name)):
                continue
            descriptor = _descriptor_from_plugin(plugin_library, plugin_name, core_api_version)
            if descriptor is not None:
                descriptors.append(descriptor)
        except _ManifestError as exc:
            errors.append(_diagnostic(f"plugin:{safe_plugin_name}", str(exc)))
            try:
                import traceback

                unreal.log_error(
                    "Unreal Editor WebUI rejected the Tool Pack manifest for plugin "
                    f'"{safe_plugin_name}".\n'
                    f"{traceback.format_exc()}"
                )
            except Exception:
                pass
        except Exception:
            errors.append(
                _diagnostic(
                    f"plugin:{safe_plugin_name}",
                    "Tool Pack discovery failed unexpectedly; see the Unreal Log.",
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

    descriptors.sort(
        key=lambda item: (
            item.pack_id.casefold(),
            item.plugin_name.casefold(),
            item.python_package,
        )
    )
    errors.sort(key=lambda item: (item["module"].casefold(), item["error"]))
    return descriptors, errors


__all__ = [
    "ToolPackDescriptor",
    "discover_tool_packs",
]
