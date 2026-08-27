#!/usr/bin/env python3
"""Reproducible Tool Pack packaging and privacy-safe installation diagnosis.

This module deliberately uses only the Python standard library.  Tool Pack
contract decisions come from ``unreal_editor_webui_toolpacks``; this module is
limited to distribution integrity, Unreal binary-variant checks, deterministic
ZIP assembly, and read-only installation inspection.
"""

from __future__ import annotations

import ctypes
import errno
import hashlib
import json
import math
import os
import re
import shutil
import stat
import sys
import tempfile
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PYTHON_ROOT = REPOSITORY_ROOT / "Python"
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

from unreal_editor_webui_toolpacks import (  # noqa: E402
    ToolPackDescriptor,
    ToolPackValidationIssue,
    validate_tool_pack_directories,
    validate_tool_pack_directory,
)


DISTRIBUTION_SCHEMA_VERSION = 1
DISTRIBUTION_FORMAT = "unreal-editor-webui-tool-pack"
DISTRIBUTION_RELATIVE_PATH = (
    Path("Content") / "UnrealEditorWebUI" / "ToolPackDistribution.json"
)
CORE_PLUGIN_NAME = "UnrealEditorWebUI"
PLATFORM_NAME = "Win64"
MAX_FILES = 10_000
MAX_TREE_DEPTH = 64
MAX_SINGLE_FILE_BYTES = 1024 * 1024 * 1024
MAX_TOTAL_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_JSON_DEPTH = 32
MAX_DIAGNOSTICS = 256
MAX_SCAN_ENTRIES = 50_000
MAX_SCAN_DEPTH = 64
STREAM_CHUNK_SIZE = 1024 * 1024
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)

_SHA256_PATTERN = re.compile(r"sha256:[0-9a-f]{64}\Z")
_BUILD_ID_PATTERN = re.compile(r"[A-Za-z0-9._+-]{1,128}\Z")
_ENGINE_VERSION_PATTERN = re.compile(r"([0-9]+)\.([0-9]+)\.([0-9]+)\Z")
_PLUGIN_NAME_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}\Z")
_PLUGIN_VERSION_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}\Z")
_SAFE_LABEL_PATTERN = re.compile(r"[^A-Za-z0-9_.-]+")
_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")
_WINDOWS_RESERVED = re.compile(
    r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$", re.IGNORECASE
)
_WINDOWS_FORBIDDEN = frozenset('<>:"\\|?*')
_ALLOWED_ROOT_DIRECTORIES = frozenset(
    {
        "Binaries",
        "Build",
        "Config",
        "Content",
        "Localization",
        "Platforms",
        "Python",
        "Resources",
        "Shaders",
        "Source",
        "ThirdParty",
        "Web",
    }
)
_REJECTED_PATH_COMPONENTS = frozenset(
    {
        ".git",
        ".idea",
        ".pytest_cache",
        ".vs",
        ".vscode",
        "__pycache__",
        "DerivedDataCache",
        "Saved",
        "node_modules",
    }
)
_REJECTED_PATH_COMPONENT_KEYS = frozenset(
    component.casefold() for component in _REJECTED_PATH_COMPONENTS
)
_ALLOWED_ROOT_DIRECTORY_KEYS = {
    component.casefold(): component for component in _ALLOWED_ROOT_DIRECTORIES
}


class DistributionError(RuntimeError):
    """Expected, privacy-safe distribution failure."""

    def __init__(
        self,
        reason_code: str,
        message: str,
        *,
        plugin_name: str = "unknown-plugin",
    ) -> None:
        super().__init__(message)
        self.reason_code = reason_code
        self.message = message
        self.plugin_name = _safe_label(plugin_name, "unknown-plugin")


@dataclass(frozen=True)
class FileRecord:
    relative_path: str
    absolute_path: Path
    size: int
    sha256: str
    snapshot_stat: os.stat_result

    def public_document(self) -> Dict[str, Any]:
        return {
            "path": self.relative_path,
            "sha256": self.sha256,
            "size": self.size,
        }


@dataclass(frozen=True)
class EngineIdentity:
    version: str
    major: int
    minor: int
    patch: int
    build_id: str

    def public_document(self) -> Dict[str, str]:
        return {
            "buildId": self.build_id,
            "platform": PLATFORM_NAME,
            "version": self.version,
        }


@dataclass(frozen=True)
class PackageResult:
    output_directory: Path
    archive_name: str
    archive_sha256: str
    manifest_name: str
    manifest_sha256: str
    sha256_name: str
    descriptor: ToolPackDescriptor
    unreal_variant: Mapping[str, Any]
    manifest_document: Mapping[str, Any]

    def public_document(self) -> Dict[str, Any]:
        return {
            "artifact": {
                "archiveName": self.archive_name,
                "archiveSha256": self.archive_sha256,
                "manifestName": self.manifest_name,
                "manifestSha256": self.manifest_sha256,
                "sha256Name": self.sha256_name,
            },
            "schemaVersion": 1,
            "toolPack": {
                "packId": self.descriptor.pack_id,
                "pluginName": self.descriptor.plugin_name,
                "pluginVersion": self.descriptor.plugin_version,
                "requiredCoreApi": self.descriptor.required_core_api,
            },
            "unrealVariant": dict(self.unreal_variant),
            "valid": True,
        }


@dataclass(frozen=True)
class DoctorIssue:
    reason_code: str
    message: str
    plugin_name: str = "installation"
    pack_id: Optional[str] = None
    scope: str = "installation"
    severity: str = "error"

    def public_document(self) -> Dict[str, Any]:
        return {
            "message": self.message,
            "packId": self.pack_id,
            "pluginName": _safe_label(self.plugin_name, "unknown-plugin"),
            "reasonCode": self.reason_code,
            "scope": self.scope,
            "severity": self.severity,
        }


@dataclass(frozen=True)
class PluginLocation:
    scope: str
    directory: Path
    descriptor_names: Tuple[str, ...]


@dataclass(frozen=True)
class DoctorPack:
    pack_id: Optional[str]
    plugin_name: str
    plugin_version: Optional[str]
    required_core_api: Optional[int]
    state: str
    integrity_status: str
    authenticity_status: str

    def public_document(self) -> Dict[str, Any]:
        return {
            "authenticityStatus": self.authenticity_status,
            "integrityStatus": self.integrity_status,
            "packId": self.pack_id,
            "pluginName": self.plugin_name,
            "pluginVersion": self.plugin_version,
            "requiredCoreApi": self.required_core_api,
            "state": self.state,
        }


@dataclass(frozen=True)
class DoctorReport:
    overall_status: str
    integrity_status: str
    authenticity_status: str
    engine: Mapping[str, str]
    core: Mapping[str, Any]
    packs: Tuple[DoctorPack, ...]
    issues: Tuple[DoctorIssue, ...]
    truncated_count: int

    @property
    def healthy(self) -> bool:
        return self.overall_status == "healthy"

    def public_document(self) -> Dict[str, Any]:
        return {
            "authenticityStatus": self.authenticity_status,
            "core": dict(self.core),
            "diagnostics": [issue.public_document() for issue in self.issues],
            "engine": dict(self.engine),
            "integrityStatus": self.integrity_status,
            "overallStatus": self.overall_status,
            "packs": [pack.public_document() for pack in self.packs],
            "schemaVersion": 1,
            "truncatedCount": self.truncated_count,
        }


def _safe_label(value: Any, fallback: str) -> str:
    text = str(value).strip() if value is not None else ""
    text = _SAFE_LABEL_PATTERN.sub("-", text).strip("-.")[:128]
    return text or fallback


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _canonical_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def _is_reparse_stat(path_stat: os.stat_result) -> bool:
    if stat.S_ISLNK(path_stat.st_mode):
        return True
    attributes = getattr(path_stat, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def _bounded_scandir(path: Path, limit: int) -> List[os.DirEntry[str]]:
    entries: List[os.DirEntry[str]] = []
    with os.scandir(path) as iterator:
        for entry in iterator:
            if len(entries) >= limit:
                raise DistributionError(
                    "scan_limit_exceeded",
                    "Directory enumeration exceeds the bounded scan limits.",
                )
            entries.append(entry)
    return entries


def _validate_raw_json_depth(document: str, label: str) -> None:
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
                raise DistributionError(
                    "json_invalid",
                    "%s exceeds the supported JSON nesting depth." % label,
                )
        elif character in "]}":
            depth = max(0, depth - 1)


def _strict_json_bytes(raw: bytes, label: str, max_bytes: int) -> Any:
    if not raw or len(raw) > max_bytes:
        raise DistributionError(
            "json_invalid",
            "%s must be non-empty and within its size limit." % label,
        )
    try:
        document = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise DistributionError(
            "json_invalid",
            "%s must use strict UTF-8 JSON." % label,
        ) from exc
    _validate_raw_json_depth(document, label)

    def closed_object(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        for key, item in pairs:
            if key in result:
                raise DistributionError(
                    "json_duplicate_field",
                    "%s contains a duplicate decoded field." % label,
                )
            result[key] = item
        return result

    def invalid_constant(_value: str) -> None:
        raise DistributionError(
            "json_invalid",
            "%s must use finite JSON numbers." % label,
        )

    def assert_finite(value: Any) -> None:
        if isinstance(value, float) and not math.isfinite(value):
            raise DistributionError(
                "json_invalid",
                "%s must use finite JSON numbers." % label,
            )
        if isinstance(value, dict):
            for item in value.values():
                assert_finite(item)
        elif isinstance(value, list):
            for item in value:
                assert_finite(item)

    try:
        value = json.loads(
            document,
            object_pairs_hook=closed_object,
            parse_constant=invalid_constant,
        )
        assert_finite(value)
        return value
    except DistributionError:
        raise
    except (json.JSONDecodeError, RecursionError) as exc:
        raise DistributionError(
            "json_invalid",
            "%s must use strict UTF-8 JSON." % label,
        ) from exc


def _read_regular_bytes(path: Path, label: str, max_bytes: int) -> bytes:
    try:
        path_stat = path.lstat()
        if _is_reparse_stat(path_stat) or not stat.S_ISREG(path_stat.st_mode):
            raise DistributionError(
                "json_invalid",
                "%s must be a regular file." % label,
            )
        if path_stat.st_size <= 0 or path_stat.st_size > max_bytes:
            raise DistributionError(
                "json_invalid",
                "%s must be non-empty and within its size limit." % label,
            )
        with _open_regular_file(path, path_stat) as source:
            raw = source.read(max_bytes + 1)
            final_stat = os.fstat(source.fileno())
        if (
            len(raw) != path_stat.st_size
            or len(raw) > max_bytes
            or not _same_file_identity(path_stat, final_stat)
            or final_stat.st_size != path_stat.st_size
            or getattr(final_stat, "st_mtime_ns", None)
            != getattr(path_stat, "st_mtime_ns", None)
        ):
            raise DistributionError(
                "json_invalid",
                "%s changed while it was being read." % label,
            )
    except DistributionError:
        raise
    except OSError as exc:
        raise DistributionError(
            "json_invalid",
            "%s could not be read." % label,
        ) from exc
    return raw


def _read_strict_json(path: Path, label: str, max_bytes: int) -> Any:
    return _strict_json_bytes(
        _read_regular_bytes(path, label, max_bytes),
        label,
        max_bytes,
    )


def _validate_path_component(component: str) -> None:
    encoded = component.encode("utf-8")
    if (
        not component
        or component in (".", "..")
        or len(encoded) > 255
        or component.endswith(".")
        or component.endswith(" ")
        or any(character in _WINDOWS_FORBIDDEN for character in component)
        or any(ord(character) < 32 or ord(character) == 127 for character in component)
        or _WINDOWS_RESERVED.fullmatch(component) is not None
    ):
        raise DistributionError(
            "payload_path_invalid",
            "Tool Pack contains a non-portable payload path.",
        )
    if unicodedata.normalize("NFC", component) != component:
        raise DistributionError(
            "payload_path_invalid",
            "Tool Pack payload paths must use Unicode NFC.",
        )


def _validate_relative_path(relative_path: str) -> None:
    if (
        not relative_path
        or relative_path.startswith(("/", "\\"))
        or _DRIVE_PREFIX.match(relative_path)
        or "\\" in relative_path
        or len(relative_path.encode("utf-8")) > 4096
    ):
        raise DistributionError(
            "payload_path_invalid",
            "Tool Pack contains a non-portable payload path.",
        )
    for component in relative_path.split("/"):
        _validate_path_component(component)


def _validate_archive_path(plugin_name: str, relative_path: str) -> str:
    archive_path = "%s/%s" % (plugin_name, relative_path)
    _validate_relative_path(archive_path)
    return archive_path


def _portable_path_key(relative_path: str) -> str:
    return unicodedata.normalize("NFC", relative_path).casefold()


def _validate_packaging_path_policy(relative_path: str) -> None:
    components = relative_path.split("/")
    root = components[0]
    name = components[-1]
    component_keys = [component.casefold() for component in components]
    if any(component in _REJECTED_PATH_COMPONENT_KEYS for component in component_keys):
        raise DistributionError(
            "payload_private_file",
            "Tool Pack payload contains a private or transient path.",
        )
    name_key = name.casefold()
    if (
        name_key in {".ds_store", "thumbs.db"}
        or name_key.endswith((".pyc", ".pyo", ".pdb", ".log", ".tmp", ".user"))
    ):
        raise DistributionError(
            "payload_private_file",
            "Tool Pack payload contains a private or transient file.",
        )
    if name_key == ".env" or name_key.startswith(".env."):
        raise DistributionError(
            "payload_private_file",
            "Tool Pack payload contains an environment file.",
        )
    if len(components) == 1:
        allowed_root_file = (
            root.casefold().endswith(".uplugin")
            or root in {"LICENSE", "NOTICE", "README.md", "SourceManifest.json"}
        )
        canonical_root_directory = _ALLOWED_ROOT_DIRECTORY_KEYS.get(root.casefold())
        if canonical_root_directory is not None and root != canonical_root_directory:
            raise DistributionError(
                "payload_path_case_invalid",
                "Tool Pack root directories must use exact portable casing.",
            )
        if not allowed_root_file and canonical_root_directory is None:
            raise DistributionError(
                "payload_root_entry_invalid",
                "Tool Pack payload contains an unsupported root entry.",
            )
    else:
        canonical_root_directory = _ALLOWED_ROOT_DIRECTORY_KEYS.get(root.casefold())
        if canonical_root_directory is None:
            raise DistributionError(
                "payload_root_entry_invalid",
                "Tool Pack payload contains an unsupported root directory.",
            )
        if root != canonical_root_directory:
            raise DistributionError(
                "payload_path_case_invalid",
                "Tool Pack root directories must use exact portable casing.",
            )


def _same_file_identity(left: os.stat_result, right: os.stat_result) -> bool:
    left_inode = getattr(left, "st_ino", 0)
    right_inode = getattr(right, "st_ino", 0)
    if left_inode and right_inode:
        return (left.st_dev, left_inode) == (right.st_dev, right_inode)
    return True


def _open_regular_file(path: Path, expected_stat: os.stat_result) -> BinaryIO:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(str(path), flags)
    except OSError as exc:
        raise DistributionError(
            "payload_file_unreadable",
            "A Tool Pack payload file could not be opened safely.",
        ) from exc
    try:
        opened_stat = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened_stat.st_mode)
            or _is_reparse_stat(opened_stat)
            or not _same_file_identity(expected_stat, opened_stat)
            or opened_stat.st_size != expected_stat.st_size
        ):
            raise DistributionError(
                "payload_changed",
                "Tool Pack payload changed while it was being inspected.",
            )
        return os.fdopen(descriptor, "rb")
    except Exception:
        os.close(descriptor)
        raise


def _hash_regular_file(path: Path, path_stat: os.stat_result) -> Tuple[int, str]:
    digest = hashlib.sha256()
    byte_count = 0
    with _open_regular_file(path, path_stat) as source:
        while True:
            chunk = source.read(STREAM_CHUNK_SIZE)
            if not chunk:
                break
            byte_count += len(chunk)
            digest.update(chunk)
        final_stat = os.fstat(source.fileno())
    if (
        byte_count != path_stat.st_size
        or final_stat.st_size != path_stat.st_size
        or not _same_file_identity(path_stat, final_stat)
        or getattr(final_stat, "st_mtime_ns", None)
        != getattr(path_stat, "st_mtime_ns", None)
    ):
        raise DistributionError(
            "payload_changed",
            "Tool Pack payload changed while it was being inspected.",
        )
    return byte_count, "sha256:" + digest.hexdigest()


def _snapshot_plugin(plugin_directory: Path) -> Tuple[FileRecord, ...]:
    try:
        root_stat = plugin_directory.lstat()
    except OSError as exc:
        raise DistributionError(
            "plugin_directory_unreadable",
            "Plugin directory could not be inspected.",
        ) from exc
    if _is_reparse_stat(root_stat) or not stat.S_ISDIR(root_stat.st_mode):
        raise DistributionError(
            "plugin_directory_invalid",
            "Plugin directory must be a real directory, not a reparse point.",
        )

    pending: List[Tuple[Path, str, int]] = [(plugin_directory, "", 0)]
    records: List[FileRecord] = []
    path_kinds: Dict[str, Tuple[str, str]] = {}
    total_bytes = 0
    scan_entry_count = 0
    reserved_key = _portable_path_key(DISTRIBUTION_RELATIVE_PATH.as_posix())

    while pending:
        directory, relative_directory, depth = pending.pop()
        try:
            entries = _bounded_scandir(
                directory,
                MAX_SCAN_ENTRIES - scan_entry_count,
            )
            scan_entry_count += len(entries)
            entries.sort(key=lambda item: item.name.encode("utf-8"))
        except (OSError, UnicodeError) as exc:
            raise DistributionError(
                "plugin_directory_unreadable",
                "Plugin directory could not be enumerated safely.",
            ) from exc
        for entry in entries:
            relative_path = (
                "%s/%s" % (relative_directory, entry.name)
                if relative_directory
                else entry.name
            )
            _validate_relative_path(relative_path)
            _validate_packaging_path_policy(relative_path)
            try:
                entry_stat = entry.stat(follow_symlinks=False)
            except OSError as exc:
                raise DistributionError(
                    "payload_file_unreadable",
                    "A Tool Pack payload entry could not be inspected.",
                ) from exc
            if _is_reparse_stat(entry_stat):
                raise DistributionError(
                    "payload_reparse_point",
                    "Tool Pack payloads must not contain reparse points or symbolic links.",
                )
            if (
                "/" not in relative_path
                and relative_path in _ALLOWED_ROOT_DIRECTORIES
                and not stat.S_ISDIR(entry_stat.st_mode)
            ):
                raise DistributionError(
                    "payload_root_entry_invalid",
                    "A Tool Pack root directory name is occupied by a file.",
                )

            path_key = _portable_path_key(relative_path)
            entry_kind = "directory" if stat.S_ISDIR(entry_stat.st_mode) else "file"
            prior = path_kinds.get(path_key)
            if prior is not None and prior != (relative_path, entry_kind):
                raise DistributionError(
                    "payload_path_collision",
                    "Tool Pack payload paths collide on a portable filesystem.",
                )
            path_kinds[path_key] = (relative_path, entry_kind)

            if stat.S_ISDIR(entry_stat.st_mode):
                child_depth = depth + 1
                if child_depth > MAX_TREE_DEPTH:
                    raise DistributionError(
                        "scan_limit_exceeded",
                        "Tool Pack payload exceeds the bounded scan limits.",
                    )
                pending.append((Path(entry.path), relative_path, child_depth))
                continue
            if not stat.S_ISREG(entry_stat.st_mode):
                raise DistributionError(
                    "payload_special_file",
                    "Tool Pack payloads may contain only regular files and directories.",
                )
            if path_key == reserved_key:
                if relative_path != DISTRIBUTION_RELATIVE_PATH.as_posix():
                    raise DistributionError(
                        "payload_path_collision",
                        "Tool Pack payload conflicts with reserved distribution metadata.",
                    )
                continue
            if len(records) >= MAX_FILES:
                raise DistributionError(
                    "scan_limit_exceeded",
                    "Tool Pack payload exceeds the bounded file-count limit.",
                )
            if entry_stat.st_size > MAX_SINGLE_FILE_BYTES:
                raise DistributionError(
                    "scan_limit_exceeded",
                    "Tool Pack payload contains a file above the size limit.",
                )
            total_bytes += entry_stat.st_size
            if total_bytes > MAX_TOTAL_FILE_BYTES:
                raise DistributionError(
                    "scan_limit_exceeded",
                    "Tool Pack payload exceeds the bounded total-size limit.",
                )
            size, file_sha256 = _hash_regular_file(Path(entry.path), entry_stat)
            records.append(
                FileRecord(
                    relative_path=relative_path,
                    absolute_path=Path(entry.path),
                    size=size,
                    sha256=file_sha256,
                    snapshot_stat=entry_stat,
                )
            )

    records.sort(key=lambda item: item.relative_path.encode("utf-8"))
    return tuple(records)


def _tree_sha256(records: Sequence[FileRecord]) -> str:
    digest = hashlib.sha256()
    for record in records:
        digest.update(record.relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(record.size).encode("ascii"))
        digest.update(b"\0")
        digest.update(record.sha256.encode("ascii"))
        digest.update(b"\n")
    return "sha256:" + digest.hexdigest()


def _read_plugin_descriptor(plugin_directory: Path, plugin_name: str) -> Dict[str, Any]:
    value = _read_strict_json(
        plugin_directory / (plugin_name + ".uplugin"),
        "Plugin descriptor",
        1024 * 1024,
    )
    if not isinstance(value, dict):
        raise DistributionError(
            "plugin_descriptor_invalid",
            "Plugin descriptor must be a JSON object.",
            plugin_name=plugin_name,
        )
    return value


def _exact_child(parent: Path, name: str, *, directory: bool) -> Path:
    try:
        matches = [
            entry
            for entry in _bounded_scandir(parent, MAX_SCAN_ENTRIES)
            if entry.name.casefold() == name.casefold()
        ]
    except OSError as exc:
        raise DistributionError(
            "payload_path_case_invalid",
            "Tool Pack required paths could not be checked for exact casing.",
        ) from exc
    if len(matches) != 1 or matches[0].name != name:
        raise DistributionError(
            "payload_path_case_invalid",
            "Tool Pack required paths must use exact portable casing.",
        )
    try:
        entry_stat = matches[0].stat(follow_symlinks=False)
    except OSError as exc:
        raise DistributionError(
            "payload_path_case_invalid",
            "Tool Pack required paths could not be inspected.",
        ) from exc
    expected_kind = stat.S_ISDIR(entry_stat.st_mode) if directory else stat.S_ISREG(entry_stat.st_mode)
    if _is_reparse_stat(entry_stat) or not expected_kind:
        raise DistributionError(
            "payload_path_case_invalid",
            "Tool Pack required paths must be real files or directories.",
        )
    return Path(matches[0].path)


def _assert_exact_tool_pack_paths(
    plugin_directory: Path,
    descriptor: ToolPackDescriptor,
) -> None:
    _exact_child(
        plugin_directory,
        descriptor.plugin_name + ".uplugin",
        directory=False,
    )
    content = _exact_child(plugin_directory, "Content", directory=True)
    manifest_root = _exact_child(content, "UnrealEditorWebUI", directory=True)
    _exact_child(manifest_root, "ToolPack.json", directory=False)
    python_root = _exact_child(content, "Python", directory=True)
    package_directory = python_root
    for segment in descriptor.python_package.split("."):
        package_directory = _exact_child(package_directory, segment, directory=True)
        _exact_child(package_directory, "__init__.py", directory=False)


def _load_engine_identity(engine_root: Path) -> EngineIdentity:
    build_version = _read_strict_json(
        engine_root / "Engine" / "Build" / "Build.version",
        "Engine build identity",
        64 * 1024,
    )
    modules = _read_strict_json(
        engine_root / "Engine" / "Binaries" / PLATFORM_NAME / "UnrealEditor.modules",
        "Engine module identity",
        1024 * 1024,
    )
    if not isinstance(build_version, dict) or not isinstance(modules, dict):
        raise DistributionError(
            "engine_identity_invalid",
            "Engine identity metadata is invalid.",
        )
    values = [
        build_version.get("MajorVersion"),
        build_version.get("MinorVersion"),
        build_version.get("PatchVersion"),
    ]
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in values):
        raise DistributionError(
            "engine_identity_invalid",
            "Engine build version metadata is invalid.",
        )
    build_id = modules.get("BuildId")
    if not isinstance(build_id, str) or _BUILD_ID_PATTERN.fullmatch(build_id) is None:
        raise DistributionError(
            "engine_identity_invalid",
            "Engine module BuildId is invalid.",
        )
    major, minor, patch = values
    return EngineIdentity(
        version="%d.%d.%d" % (major, minor, patch),
        major=major,
        minor=minor,
        patch=patch,
        build_id=build_id,
    )


def _module_names(plugin_descriptor: Mapping[str, Any], plugin_name: str) -> Tuple[str, ...]:
    raw_modules = plugin_descriptor.get("Modules")
    if raw_modules is None or raw_modules == []:
        return ()
    if not isinstance(raw_modules, list):
        raise DistributionError(
            "plugin_descriptor_invalid",
            "Plugin descriptor Modules must be an array.",
            plugin_name=plugin_name,
        )
    names: List[str] = []
    for module in raw_modules:
        name = module.get("Name") if isinstance(module, dict) else None
        if not isinstance(name, str) or not name or name in names:
            raise DistributionError(
                "plugin_descriptor_invalid",
                "Plugin descriptor contains invalid module metadata.",
                plugin_name=plugin_name,
            )
        names.append(name)
    return tuple(names)


def _code_plugin_variant(
    plugin_directory: Path,
    plugin_descriptor: Mapping[str, Any],
    plugin_name: str,
    engine: EngineIdentity,
) -> Dict[str, Any]:
    engine_version_value = plugin_descriptor.get("EngineVersion")
    if not isinstance(engine_version_value, str):
        raise DistributionError(
            "ue_variant_metadata_missing",
            "Code plugin descriptor must contain packaged EngineVersion metadata.",
            plugin_name=plugin_name,
        )
    version_match = _ENGINE_VERSION_PATTERN.fullmatch(engine_version_value)
    if version_match is None:
        raise DistributionError(
            "ue_variant_metadata_missing",
            "Code plugin EngineVersion metadata is invalid.",
            plugin_name=plugin_name,
        )
    plugin_major, plugin_minor, _plugin_patch = (
        int(value) for value in version_match.groups()
    )
    if (plugin_major, plugin_minor) != (engine.major, engine.minor):
        raise DistributionError(
            "ue_engine_version_mismatch",
            "Code plugin EngineVersion does not match the selected Unreal Engine.",
            plugin_name=plugin_name,
        )

    modules_path = (
        plugin_directory / "Binaries" / PLATFORM_NAME / "UnrealEditor.modules"
    )
    try:
        plugin_modules = _read_strict_json(
            modules_path,
            "Packaged plugin module identity",
            1024 * 1024,
        )
    except DistributionError as exc:
        raise DistributionError(
            "ue_variant_metadata_missing",
            "Code plugin packaged module metadata is missing or invalid.",
            plugin_name=plugin_name,
        ) from exc
    if not isinstance(plugin_modules, dict):
        raise DistributionError(
            "ue_variant_metadata_missing",
            "Code plugin packaged module metadata is invalid.",
            plugin_name=plugin_name,
        )
    plugin_build_id = plugin_modules.get("BuildId")
    if not isinstance(plugin_build_id, str) or _BUILD_ID_PATTERN.fullmatch(plugin_build_id) is None:
        raise DistributionError(
            "ue_variant_metadata_missing",
            "Code plugin packaged module BuildId is invalid.",
            plugin_name=plugin_name,
        )
    if plugin_build_id != engine.build_id:
        raise DistributionError(
            "ue_module_build_id_mismatch",
            "Code plugin module BuildId does not match the selected Unreal Engine.",
            plugin_name=plugin_name,
        )
    module_map = plugin_modules.get("Modules")
    if not isinstance(module_map, dict):
        raise DistributionError(
            "ue_variant_metadata_missing",
            "Code plugin packaged module map is invalid.",
            plugin_name=plugin_name,
        )
    for module_name in _module_names(plugin_descriptor, plugin_name):
        binary_name = module_map.get(module_name)
        if (
            not isinstance(binary_name, str)
            or not binary_name
            or "/" in binary_name
            or "\\" in binary_name
            or ":" in binary_name
            or Path(binary_name).name != binary_name
        ):
            raise DistributionError(
                "ue_variant_metadata_missing",
                "Code plugin is missing a packaged module binary mapping.",
                plugin_name=plugin_name,
            )
        try:
            _validate_path_component(binary_name)
        except DistributionError as exc:
            raise DistributionError(
                "ue_variant_metadata_missing",
                "Code plugin contains a non-portable module binary mapping.",
                plugin_name=plugin_name,
            ) from exc
        binary_path = modules_path.parent / binary_name
        try:
            binary_stat = binary_path.lstat()
        except OSError as exc:
            raise DistributionError(
                "ue_variant_metadata_missing",
                "Code plugin is missing a packaged module binary.",
                plugin_name=plugin_name,
            ) from exc
        if _is_reparse_stat(binary_stat) or not stat.S_ISREG(binary_stat.st_mode):
            raise DistributionError(
                "ue_variant_metadata_missing",
                "Code plugin packaged module binary is invalid.",
                plugin_name=plugin_name,
            )
    return {
        "engineVersion": engine.version,
        "kind": "precompiled",
        "moduleBuildId": plugin_build_id,
        "platform": PLATFORM_NAME,
        "pluginEngineVersion": engine_version_value,
    }


def _content_only_variant(
    plugin_directory: Path,
    plugin_descriptor: Mapping[str, Any],
    plugin_name: str,
) -> Dict[str, Any]:
    if plugin_descriptor.get("NoCode") is not True:
        raise DistributionError(
            "ue_variant_metadata_missing",
            "Content-only Tool Packs must explicitly declare NoCode true.",
            plugin_name=plugin_name,
        )
    if _module_names(plugin_descriptor, plugin_name):
        raise DistributionError(
            "ue_variant_metadata_missing",
            "Content-only Tool Packs must not declare code modules.",
            plugin_name=plugin_name,
        )
    binaries_path = plugin_directory / "Binaries"
    if os.path.lexists(str(binaries_path)):
        raise DistributionError(
            "ue_variant_metadata_missing",
            "Content-only Tool Packs must not contain a Binaries directory.",
            plugin_name=plugin_name,
        )
    return {
        "engineVersion": None,
        "kind": "content_only",
        "moduleBuildId": None,
        "platform": None,
        "pluginEngineVersion": None,
    }


def _distribution_manifest(
    descriptor: ToolPackDescriptor,
    records: Sequence[FileRecord],
    unreal_variant: Mapping[str, Any],
) -> Dict[str, Any]:
    return {
        "files": [record.public_document() for record in records],
        "format": DISTRIBUTION_FORMAT,
        "payload": {
            "fileCount": len(records),
            "totalBytes": sum(record.size for record in records),
            "treeSha256": _tree_sha256(records),
        },
        "plugin": {
            "name": descriptor.plugin_name,
            "version": descriptor.plugin_version,
        },
        "producer": {
            "contractVersion": 1,
            "name": "unreal-editor-webui-tool-packager",
        },
        "schemaVersion": DISTRIBUTION_SCHEMA_VERSION,
        "toolPack": {
            "commandNamespace": descriptor.command_namespace,
            "id": descriptor.pack_id,
            "pythonPackage": descriptor.python_package,
            "requiredCoreApi": descriptor.required_core_api,
            "schemaVersion": 1,
        },
        "unrealVariant": dict(unreal_variant),
    }


def _zip_info(filename: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(filename=filename, date_time=ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.create_version = 20
    info.extract_version = 20
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    info.internal_attr = 0
    info.extra = b""
    info.comment = b""
    return info


def _stream_record_to_zip(
    archive: zipfile.ZipFile,
    archive_name: str,
    record: FileRecord,
) -> None:
    digest = hashlib.sha256()
    byte_count = 0
    info = _zip_info(archive_name)
    info.file_size = record.size
    with _open_regular_file(record.absolute_path, record.snapshot_stat) as source:
        with archive.open(info, mode="w", force_zip64=False) as destination:
            while True:
                chunk = source.read(STREAM_CHUNK_SIZE)
                if not chunk:
                    break
                byte_count += len(chunk)
                digest.update(chunk)
                destination.write(chunk)
        final_stat = os.fstat(source.fileno())
    if (
        byte_count != record.size
        or "sha256:" + digest.hexdigest() != record.sha256
        or final_stat.st_size != record.size
        or not _same_file_identity(record.snapshot_stat, final_stat)
        or getattr(final_stat, "st_mtime_ns", None)
        != getattr(record.snapshot_stat, "st_mtime_ns", None)
    ):
        raise DistributionError(
            "payload_changed",
            "Tool Pack payload changed while the archive was being written.",
        )


def _write_deterministic_zip(
    archive_path: Path,
    plugin_name: str,
    records: Sequence[FileRecord],
    manifest_bytes: bytes,
) -> None:
    manifest_archive_path = _validate_archive_path(
        plugin_name,
        DISTRIBUTION_RELATIVE_PATH.as_posix(),
    )
    record_by_archive_path = {
        _validate_archive_path(plugin_name, record.relative_path): record
        for record in records
    }
    entry_names = sorted(
        list(record_by_archive_path) + [manifest_archive_path],
        key=lambda value: value.encode("utf-8"),
    )
    with zipfile.ZipFile(
        archive_path,
        mode="x",
        compression=zipfile.ZIP_STORED,
        allowZip64=False,
        strict_timestamps=True,
    ) as archive:
        archive.comment = b""
        for entry_name in entry_names:
            if entry_name == manifest_archive_path:
                archive.writestr(
                    _zip_info(entry_name),
                    manifest_bytes,
                    compress_type=zipfile.ZIP_STORED,
                )
            else:
                _stream_record_to_zip(
                    archive,
                    entry_name,
                    record_by_archive_path[entry_name],
                )

    with zipfile.ZipFile(archive_path, "r") as archive:
        infos = archive.infolist()
        if [info.filename for info in infos] != entry_names:
            raise DistributionError(
                "archive_verification_failed",
                "Deterministic archive entry ordering verification failed.",
            )
        for info in infos:
            if (
                info.is_dir()
                or info.compress_type != zipfile.ZIP_STORED
                or info.date_time != ZIP_TIMESTAMP
                or info.create_system != 3
                or (info.external_attr >> 16) != (stat.S_IFREG | 0o644)
                or info.extra
                or info.comment
                or info.flag_bits & 0x08
            ):
                raise DistributionError(
                    "archive_verification_failed",
                    "Deterministic archive metadata verification failed.",
                )
        if archive.comment:
            raise DistributionError(
                "archive_verification_failed",
                "Deterministic archive comment verification failed.",
            )
        for entry_name in entry_names:
            if entry_name == manifest_archive_path:
                expected_size = len(manifest_bytes)
                expected_sha256 = _sha256_bytes(manifest_bytes)
            else:
                expected_record = record_by_archive_path[entry_name]
                expected_size = expected_record.size
                expected_sha256 = expected_record.sha256
            digest = hashlib.sha256()
            byte_count = 0
            with archive.open(entry_name, "r") as source:
                while True:
                    chunk = source.read(STREAM_CHUNK_SIZE)
                    if not chunk:
                        break
                    byte_count += len(chunk)
                    digest.update(chunk)
            if (
                byte_count != expected_size
                or "sha256:" + digest.hexdigest() != expected_sha256
            ):
                raise DistributionError(
                    "archive_verification_failed",
                    "A deterministic archive member failed content verification.",
                )
        if archive.read(manifest_archive_path) != manifest_bytes:
            raise DistributionError(
                "archive_verification_failed",
                "Embedded distribution manifest verification failed.",
            )


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        path_stat = path.lstat()
    except OSError as exc:
        raise DistributionError(
            "artifact_unreadable",
            "Generated artifact could not be inspected.",
        ) from exc
    with _open_regular_file(path, path_stat) as source:
        while True:
            chunk = source.read(STREAM_CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _atomic_rename_no_replace(source: Path, destination: Path) -> None:
    if os.name == "nt":
        os.rename(str(source), str(destination))
        return
    if sys.platform.startswith("linux"):
        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = getattr(libc, "renameat2", None)
        if renameat2 is None:
            raise DistributionError(
                "atomic_publish_unavailable",
                "This platform lacks atomic no-replace directory publication.",
            )
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameat2.restype = ctypes.c_int
        result = renameat2(
            -100,
            os.fsencode(str(source)),
            -100,
            os.fsencode(str(destination)),
            1,
        )
        if result == 0:
            return
        error_number = ctypes.get_errno()
        if error_number == errno.EEXIST:
            raise FileExistsError(error_number, os.strerror(error_number))
        raise OSError(error_number, os.strerror(error_number))
    if sys.platform == "darwin":
        libc = ctypes.CDLL(None, use_errno=True)
        renamex_np = getattr(libc, "renamex_np", None)
        if renamex_np is None:
            raise DistributionError(
                "atomic_publish_unavailable",
                "This platform lacks atomic no-replace directory publication.",
            )
        renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex_np.restype = ctypes.c_int
        if renamex_np(os.fsencode(str(source)), os.fsencode(str(destination)), 0x4) == 0:
            return
        error_number = ctypes.get_errno()
        if error_number == errno.EEXIST:
            raise FileExistsError(error_number, os.strerror(error_number))
        raise OSError(error_number, os.strerror(error_number))
    raise DistributionError(
        "atomic_publish_unavailable",
        "This platform lacks atomic no-replace directory publication.",
    )


def _cleanup_private_directory(path: Path, parent: Path) -> None:
    if path.parent != parent or not path.name.startswith(".tool-pack-package-"):
        raise DistributionError(
            "cleanup_failed",
            "Private packaging cleanup path failed its safety check.",
        )
    if os.path.lexists(str(path)):
        shutil.rmtree(str(path))


def package_tool_pack(
    plugin_directory_value: str,
    output_directory_value: str,
    *,
    engine_root_value: Optional[str] = None,
) -> PackageResult:
    plugin_directory = Path(plugin_directory_value)
    validation = validate_tool_pack_directory(plugin_directory)
    if not validation.valid or validation.descriptor is None:
        issue = validation.issues[0] if validation.issues else ToolPackValidationIssue(
            reason_code="validation_failed",
            plugin_name=validation.plugin_name,
            message="Tool Pack validation failed.",
        )
        raise DistributionError(
            issue.reason_code,
            issue.message,
            plugin_name="candidate",
        )
    descriptor = validation.descriptor
    _assert_exact_tool_pack_paths(plugin_directory, descriptor)
    plugin_descriptor = _read_plugin_descriptor(
        plugin_directory,
        descriptor.plugin_name,
    )
    module_names = _module_names(plugin_descriptor, descriptor.plugin_name)
    if module_names:
        if engine_root_value is None:
            raise DistributionError(
                "ue_variant_metadata_missing",
                "Code Tool Packs require an explicit engine root for variant validation.",
                plugin_name=descriptor.plugin_name,
            )
        engine = _load_engine_identity(Path(engine_root_value))
        unreal_variant = _code_plugin_variant(
            plugin_directory,
            plugin_descriptor,
            descriptor.plugin_name,
            engine,
        )
        variant_suffix = "-UE%d%d-%s" % (engine.major, engine.minor, PLATFORM_NAME)
    else:
        unreal_variant = _content_only_variant(
            plugin_directory,
            plugin_descriptor,
            descriptor.plugin_name,
        )
        variant_suffix = ""

    records = _snapshot_plugin(plugin_directory)
    validation_after_snapshot = validate_tool_pack_directory(plugin_directory)
    if (
        not validation_after_snapshot.valid
        or validation_after_snapshot.descriptor != descriptor
    ):
        issue = (
            validation_after_snapshot.issues[0]
            if validation_after_snapshot.issues
            else ToolPackValidationIssue(
                reason_code="payload_changed",
                plugin_name=descriptor.plugin_name,
                message="Tool Pack contract changed during packaging.",
            )
        )
        raise DistributionError(
            issue.reason_code,
            issue.message,
            plugin_name=issue.plugin_name,
        )
    manifest_document = _distribution_manifest(descriptor, records, unreal_variant)
    manifest_bytes = _canonical_json_bytes(manifest_document)
    if len(manifest_bytes) > MAX_MANIFEST_BYTES:
        raise DistributionError(
            "distribution_manifest_too_large",
            "Distribution manifest exceeds its bounded size limit.",
            plugin_name=descriptor.plugin_name,
        )

    output_directory = Path(output_directory_value).absolute()
    output_parent = output_directory.parent
    try:
        parent_stat = output_parent.lstat()
    except OSError as exc:
        raise DistributionError(
            "output_parent_invalid",
            "Output directory parent is unavailable.",
            plugin_name=descriptor.plugin_name,
        ) from exc
    if _is_reparse_stat(parent_stat) or not stat.S_ISDIR(parent_stat.st_mode):
        raise DistributionError(
            "output_parent_invalid",
            "Output directory parent must be a real directory.",
            plugin_name=descriptor.plugin_name,
        )
    try:
        canonical_plugin = plugin_directory.resolve(strict=True)
        canonical_parent = output_parent.resolve(strict=True)
        canonical_parent.relative_to(canonical_plugin)
    except ValueError:
        pass
    except (OSError, RuntimeError) as exc:
        raise DistributionError(
            "output_parent_invalid",
            "Output directory parent could not be canonicalized.",
            plugin_name=descriptor.plugin_name,
        ) from exc
    else:
        raise DistributionError(
            "output_inside_plugin",
            "Output directory must stay outside the Tool Pack plugin directory.",
            plugin_name=descriptor.plugin_name,
        )
    if os.path.lexists(str(output_directory)):
        raise DistributionError(
            "output_exists",
            "Output directory must be fresh and must not already exist.",
            plugin_name=descriptor.plugin_name,
        )

    base_name = "%s-%s-ToolPack%s" % (
        descriptor.plugin_name,
        descriptor.plugin_version,
        variant_suffix,
    )
    archive_name = base_name + ".zip"
    manifest_name = base_name + ".manifest.json"
    sha_name = archive_name + ".sha256"
    staging = Path(
        tempfile.mkdtemp(prefix=".tool-pack-package-", dir=str(output_parent))
    )
    published = False
    try:
        archive_path = staging / archive_name
        manifest_path = staging / manifest_name
        sha_path = staging / sha_name
        _write_deterministic_zip(
            archive_path,
            descriptor.plugin_name,
            records,
            manifest_bytes,
        )
        manifest_path.write_bytes(manifest_bytes)
        archive_sha256 = _hash_file(archive_path)
        manifest_sha256 = _sha256_bytes(manifest_bytes)
        with sha_path.open("x", encoding="ascii", newline="\n") as sha_file:
            sha_file.write(
                "%s  %s\n"
                % (archive_sha256.removeprefix("sha256:"), archive_name)
            )
        if manifest_path.read_bytes() != manifest_bytes:
            raise DistributionError(
                "artifact_verification_failed",
                "Distribution manifest sidecar verification failed.",
                plugin_name=descriptor.plugin_name,
            )
        final_validation = validate_tool_pack_directory(plugin_directory)
        final_records = _snapshot_plugin(plugin_directory)
        if (
            not final_validation.valid
            or final_validation.descriptor != descriptor
            or [record.public_document() for record in final_records]
            != [record.public_document() for record in records]
        ):
            raise DistributionError(
                "payload_changed",
                "Tool Pack payload changed before atomic publication.",
                plugin_name=descriptor.plugin_name,
            )
        try:
            _atomic_rename_no_replace(staging, output_directory)
        except FileExistsError as exc:
            raise DistributionError(
                "output_exists",
                "Output directory appeared during atomic publication.",
                plugin_name=descriptor.plugin_name,
            ) from exc
        staging = output_directory
        published = True
        return PackageResult(
            output_directory=output_directory,
            archive_name=archive_name,
            archive_sha256=archive_sha256,
            manifest_name=manifest_name,
            manifest_sha256=manifest_sha256,
            sha256_name=sha_name,
            descriptor=descriptor,
            unreal_variant=unreal_variant,
            manifest_document=manifest_document,
        )
    finally:
        if not published and os.path.lexists(str(staging)):
            _cleanup_private_directory(staging, output_parent)


def _issue_sort_key(issue: DoctorIssue) -> Tuple[str, str, str, str, str]:
    return (
        issue.plugin_name.casefold(),
        issue.plugin_name,
        issue.reason_code,
        issue.pack_id or "",
        issue.scope,
    )


def _append_issue(issues: List[DoctorIssue], issue: DoctorIssue) -> None:
    issues.append(issue)


def _bounded_issues(issues: Sequence[DoctorIssue]) -> Tuple[Tuple[DoctorIssue, ...], int]:
    ordered = sorted(issues, key=_issue_sort_key)
    if len(ordered) <= MAX_DIAGNOSTICS:
        return tuple(ordered), 0
    truncated = len(ordered) - (MAX_DIAGNOSTICS - 1)
    visible = ordered[: MAX_DIAGNOSTICS - 1]
    visible.append(
        DoctorIssue(
            reason_code="diagnostics_truncated",
            message="Additional installation diagnostics were omitted by the output limit.",
            severity="error",
        )
    )
    return tuple(visible), truncated


def _scan_plugin_root(
    root: Path,
    scope: str,
    *,
    missing_is_error: bool,
) -> Tuple[List[PluginLocation], List[DoctorIssue]]:
    locations: List[PluginLocation] = []
    issues: List[DoctorIssue] = []
    try:
        root_stat = root.lstat()
    except FileNotFoundError:
        if missing_is_error:
            issues.append(
                DoctorIssue(
                    reason_code="scan_root_unreadable",
                    message="An explicit plugin scan root is unavailable.",
                    plugin_name=scope,
                    scope=scope,
                )
            )
        return locations, issues
    except OSError:
        issues.append(
            DoctorIssue(
                reason_code="scan_root_unreadable",
                message="An explicit plugin scan root could not be inspected.",
                plugin_name=scope,
                scope=scope,
            )
        )
        return locations, issues
    if _is_reparse_stat(root_stat) or not stat.S_ISDIR(root_stat.st_mode):
        issues.append(
            DoctorIssue(
                reason_code="scan_root_invalid",
                message="An explicit plugin scan root must be a real directory.",
                plugin_name=scope,
                scope=scope,
            )
        )
        return locations, issues

    pending: List[Tuple[Path, int]] = [(root, 0)]
    entry_count = 0
    while pending:
        directory, depth = pending.pop()
        try:
            entries = _bounded_scandir(
                directory,
                MAX_SCAN_ENTRIES - entry_count,
            )
            entries.sort(key=lambda item: (item.name.casefold(), item.name))
        except DistributionError as exc:
            issues.append(
                DoctorIssue(
                    reason_code=exc.reason_code,
                    message=exc.message,
                    plugin_name=scope,
                    scope=scope,
                )
            )
            break
        except OSError:
            issues.append(
                DoctorIssue(
                    reason_code="scan_root_unreadable",
                    message="A plugin scan root contains an unreadable directory.",
                    plugin_name=scope,
                    scope=scope,
                )
            )
            continue
        entry_count += len(entries)
        descriptor_names: List[str] = []
        child_directories: List[Path] = []
        for entry in entries:
            try:
                entry_stat = entry.stat(follow_symlinks=False)
            except OSError:
                issues.append(
                    DoctorIssue(
                        reason_code="scan_root_unreadable",
                        message="A plugin scan root contains an unreadable entry.",
                        plugin_name=scope,
                        scope=scope,
                    )
                )
                continue
            if _is_reparse_stat(entry_stat):
                issues.append(
                    DoctorIssue(
                        reason_code="scan_reparse_point",
                        message="A plugin scan root contains a reparse point.",
                        plugin_name=scope,
                        scope=scope,
                    )
                )
                continue
            if stat.S_ISREG(entry_stat.st_mode) and entry.name.casefold().endswith(".uplugin"):
                descriptor_names.append(entry.name[:-8])
            elif stat.S_ISDIR(entry_stat.st_mode):
                child_directories.append(Path(entry.path))
        marker_candidate = False
        if not descriptor_names:
            marker_candidate, _exact_case, _has_contract, _has_distribution = (
                _tool_pack_candidate(directory)
            )
        if descriptor_names or marker_candidate:
            locations.append(
                PluginLocation(
                    scope=scope,
                    directory=directory,
                    descriptor_names=tuple(sorted(descriptor_names, key=str.casefold)),
                )
            )
            continue
        child_depth = depth + 1
        if child_depth > MAX_SCAN_DEPTH and child_directories:
            issues.append(
                DoctorIssue(
                    reason_code="scan_limit_exceeded",
                    message="A plugin scan root exceeds the bounded scan depth.",
                    plugin_name=scope,
                    scope=scope,
                )
            )
            continue
        pending.extend((child, child_depth) for child in reversed(child_directories))
    return locations, issues


def _tool_pack_candidate(plugin_directory: Path) -> Tuple[bool, bool, bool, bool]:
    """Return candidate, exact-case, contract, and distribution-marker evidence."""

    current = plugin_directory
    exact_case = True
    for expected_name in ("Content", "UnrealEditorWebUI"):
        try:
            matches = sorted(
                (
                    entry
                    for entry in _bounded_scandir(current, MAX_SCAN_ENTRIES)
                    if entry.name.casefold() == expected_name.casefold()
                ),
                key=lambda entry: entry.name,
            )
        except (DistributionError, OSError):
            return False, False, False, False
        if not matches:
            return False, exact_case, False, False
        exact_matches = [entry for entry in matches if entry.name == expected_name]
        entry = exact_matches[0] if len(exact_matches) == 1 else matches[0]
        if len(matches) != 1 or entry.name != expected_name:
            exact_case = False
        try:
            entry_stat = entry.stat(follow_symlinks=False)
        except OSError:
            return False, False, False, False
        if _is_reparse_stat(entry_stat) or not stat.S_ISDIR(entry_stat.st_mode):
            return False, False, False, False
        current = Path(entry.path)

    try:
        entries = _bounded_scandir(current, MAX_SCAN_ENTRIES)
    except (DistributionError, OSError):
        return False, False, False, False
    evidence: Dict[str, List[os.DirEntry[str]]] = {
        "ToolPack.json": [],
        "ToolPackDistribution.json": [],
    }
    for entry in entries:
        for expected_name in evidence:
            if entry.name.casefold() == expected_name.casefold():
                evidence[expected_name].append(entry)
    present: Dict[str, bool] = {}
    for expected_name, matches in evidence.items():
        present[expected_name] = bool(matches)
        if not matches:
            continue
        exact_matches = [entry for entry in matches if entry.name == expected_name]
        entry = exact_matches[0] if len(exact_matches) == 1 else matches[0]
        if len(matches) != 1 or entry.name != expected_name:
            exact_case = False
        try:
            entry_stat = entry.stat(follow_symlinks=False)
        except OSError:
            exact_case = False
            continue
        if _is_reparse_stat(entry_stat) or not stat.S_ISREG(entry_stat.st_mode):
            exact_case = False
    has_contract = present["ToolPack.json"]
    has_distribution = present["ToolPackDistribution.json"]
    return has_contract or has_distribution, exact_case, has_contract, has_distribution


def _resolve_project(project_value: str) -> Tuple[Path, Path]:
    candidate = Path(project_value)
    try:
        candidate_stat = candidate.lstat()
    except OSError as exc:
        raise DistributionError(
            "project_invalid",
            "Project path is unavailable.",
        ) from exc
    if _is_reparse_stat(candidate_stat):
        raise DistributionError(
            "project_invalid",
            "Project path must not be a reparse point.",
        )
    if stat.S_ISREG(candidate_stat.st_mode):
        if candidate.suffix.casefold() != ".uproject":
            raise DistributionError(
                "project_invalid",
                "Project file must use the .uproject extension.",
            )
        return candidate, candidate.parent
    if not stat.S_ISDIR(candidate_stat.st_mode):
        raise DistributionError(
            "project_invalid",
            "Project path must identify a project file or directory.",
        )
    try:
        projects = sorted(
            (
                path
                for path in candidate.iterdir()
                if path.is_file() and path.suffix.casefold() == ".uproject"
            ),
            key=lambda path: (path.name.casefold(), path.name),
        )
    except OSError as exc:
        raise DistributionError(
            "project_invalid",
            "Project directory could not be inspected.",
        ) from exc
    if len(projects) != 1:
        raise DistributionError(
            "project_invalid",
            "Project directory must contain exactly one root .uproject file.",
        )
    return projects[0], candidate


def _project_core_disabled(project_file: Path) -> bool:
    value = _read_strict_json(project_file, "Project descriptor", 1024 * 1024)
    if not isinstance(value, dict):
        raise DistributionError(
            "project_descriptor_invalid",
            "Project descriptor must be a JSON object.",
        )
    plugins = value.get("Plugins", [])
    if not isinstance(plugins, list):
        raise DistributionError(
            "project_descriptor_invalid",
            "Project descriptor Plugins must be an array.",
        )
    matches = []
    for plugin in plugins:
        if not isinstance(plugin, dict):
            raise DistributionError(
                "project_descriptor_invalid",
                "Project descriptor contains invalid plugin metadata.",
            )
        name = plugin.get("Name")
        if isinstance(name, str) and name.casefold() == CORE_PLUGIN_NAME.casefold():
            matches.append(plugin)
    if len(matches) > 1:
        raise DistributionError(
            "project_descriptor_invalid",
            "Project descriptor contains duplicate core plugin entries.",
        )
    return bool(matches and matches[0].get("Enabled") is not True)


def _distribution_document(
    plugin_directory: Path,
    descriptor: ToolPackDescriptor,
    engine: EngineIdentity,
) -> Tuple[Mapping[str, Any], bytes, Tuple[FileRecord, ...], Mapping[str, Any]]:
    _assert_exact_tool_pack_paths(plugin_directory, descriptor)
    manifest_path = plugin_directory / DISTRIBUTION_RELATIVE_PATH
    if not os.path.lexists(str(manifest_path)):
        raise DistributionError(
            "distribution_manifest_missing",
            "Packaged Tool Pack distribution manifest is missing.",
            plugin_name=descriptor.plugin_name,
        )
    try:
        manifest_bytes = _read_regular_bytes(
            manifest_path,
            "Tool Pack distribution manifest",
            MAX_MANIFEST_BYTES,
        )
        document = _strict_json_bytes(
            manifest_bytes,
            "Tool Pack distribution manifest",
            MAX_MANIFEST_BYTES,
        )
    except DistributionError as exc:
        raise DistributionError(
            "distribution_manifest_invalid",
            "Packaged Tool Pack distribution manifest is invalid.",
            plugin_name=descriptor.plugin_name,
        ) from exc
    if manifest_bytes != _canonical_json_bytes(document):
        raise DistributionError(
            "distribution_manifest_invalid",
            "Packaged Tool Pack distribution manifest must use canonical JSON bytes.",
            plugin_name=descriptor.plugin_name,
        )
    if not isinstance(document, dict) or set(document) != {
        "files",
        "format",
        "payload",
        "plugin",
        "producer",
        "schemaVersion",
        "toolPack",
        "unrealVariant",
    }:
        raise DistributionError(
            "distribution_manifest_invalid",
            "Packaged Tool Pack distribution manifest uses an unsupported schema.",
            plugin_name=descriptor.plugin_name,
        )
    if (
        document.get("schemaVersion") != DISTRIBUTION_SCHEMA_VERSION
        or document.get("format") != DISTRIBUTION_FORMAT
        or document.get("plugin")
        != {"name": descriptor.plugin_name, "version": descriptor.plugin_version}
        or document.get("toolPack")
        != {
            "commandNamespace": descriptor.command_namespace,
            "id": descriptor.pack_id,
            "pythonPackage": descriptor.python_package,
            "requiredCoreApi": descriptor.required_core_api,
            "schemaVersion": 1,
        }
        or document.get("producer")
        != {
            "contractVersion": 1,
            "name": "unreal-editor-webui-tool-packager",
        }
    ):
        raise DistributionError(
            "distribution_manifest_invalid",
            "Packaged Tool Pack distribution identity does not match the validated plugin.",
            plugin_name=descriptor.plugin_name,
        )
    plugin_descriptor = _read_plugin_descriptor(plugin_directory, descriptor.plugin_name)
    if _module_names(plugin_descriptor, descriptor.plugin_name):
        expected_variant = _code_plugin_variant(
            plugin_directory,
            plugin_descriptor,
            descriptor.plugin_name,
            engine,
        )
    else:
        expected_variant = _content_only_variant(
            plugin_directory,
            plugin_descriptor,
            descriptor.plugin_name,
        )
    if document.get("unrealVariant") != expected_variant:
        raise DistributionError(
            "ue_variant_metadata_mismatch",
            "Distribution UE variant metadata does not match the installed plugin.",
            plugin_name=descriptor.plugin_name,
        )
    records = _snapshot_plugin(plugin_directory)
    files = document.get("files")
    payload = document.get("payload")
    if not isinstance(files, list) or not isinstance(payload, dict):
        raise DistributionError(
            "distribution_manifest_invalid",
            "Distribution payload metadata is invalid.",
            plugin_name=descriptor.plugin_name,
        )
    expected_documents = [record.public_document() for record in records]
    if files != expected_documents:
        actual_paths = {record.relative_path for record in records}
        declared_paths = {
            item.get("path")
            for item in files
            if isinstance(item, dict) and isinstance(item.get("path"), str)
        }
        if declared_paths - actual_paths:
            code = "payload_file_missing"
            message = "Installed Tool Pack is missing a file declared by its distribution manifest."
        elif actual_paths - declared_paths:
            code = "payload_file_unexpected"
            message = "Installed Tool Pack contains an undeclared payload file."
        else:
            code = "payload_hash_mismatch"
            message = "Installed Tool Pack payload does not match its declared file hashes."
        raise DistributionError(
            code,
            message,
            plugin_name=descriptor.plugin_name,
        )
    expected_payload = {
        "fileCount": len(records),
        "totalBytes": sum(record.size for record in records),
        "treeSha256": _tree_sha256(records),
    }
    if payload != expected_payload:
        raise DistributionError(
            "payload_tree_digest_mismatch",
            "Installed Tool Pack tree digest does not match its payload.",
            plugin_name=descriptor.plugin_name,
        )
    return document, manifest_bytes, records, expected_variant


def _read_trust_lock(trust_file_value: Optional[str]) -> Optional[Dict[str, str]]:
    if trust_file_value is None:
        return None
    value = _read_strict_json(Path(trust_file_value), "Tool Pack trust lock", 1024 * 1024)
    if not isinstance(value, dict) or set(value) != {"packs", "schemaVersion"}:
        raise DistributionError(
            "trust_lock_invalid",
            "Tool Pack trust lock uses an unsupported schema.",
        )
    if value.get("schemaVersion") != 1 or not isinstance(value.get("packs"), list):
        raise DistributionError(
            "trust_lock_invalid",
            "Tool Pack trust lock uses an unsupported schema.",
        )
    anchors: Dict[str, str] = {}
    for item in value["packs"]:
        if not isinstance(item, dict) or set(item) != {"manifestSha256", "packId"}:
            raise DistributionError(
                "trust_lock_invalid",
                "Tool Pack trust lock contains an invalid entry.",
            )
        pack_id = item.get("packId")
        manifest_sha256 = item.get("manifestSha256")
        if (
            not isinstance(pack_id, str)
            or not pack_id
            or pack_id in anchors
            or not isinstance(manifest_sha256, str)
            or _SHA256_PATTERN.fullmatch(manifest_sha256) is None
        ):
            raise DistributionError(
                "trust_lock_invalid",
                "Tool Pack trust lock contains an invalid or duplicate entry.",
            )
        anchors[pack_id] = manifest_sha256
    return anchors


def _doctor_issue_from_validation(
    issue: ToolPackValidationIssue,
    public_plugin_names: Mapping[str, str],
) -> DoctorIssue:
    public_name = public_plugin_names.get(issue.plugin_name.casefold(), "candidate")
    return DoctorIssue(
        reason_code=issue.reason_code,
        message=issue.message,
        plugin_name=public_name,
        scope="tool-pack",
    )


def doctor_installation(
    project_value: str,
    engine_root_value: str,
    external_root_values: Sequence[str],
    *,
    trust_file_value: Optional[str] = None,
) -> DoctorReport:
    issues: List[DoctorIssue] = []
    project_file, project_root = _resolve_project(project_value)
    engine = _load_engine_identity(Path(engine_root_value))
    trust_anchors = _read_trust_lock(trust_file_value)
    try:
        if _project_core_disabled(project_file):
            issues.append(
                DoctorIssue(
                    reason_code="core_disabled",
                    message="Project descriptor explicitly disables UnrealEditorWebUI.",
                    plugin_name=CORE_PLUGIN_NAME,
                    scope="project",
                )
            )
    except DistributionError as exc:
        issues.append(
            DoctorIssue(
                reason_code=exc.reason_code,
                message=exc.message,
                plugin_name="project",
                scope="project",
            )
        )

    root_specs: List[Tuple[Path, str, bool]] = [
        (project_root / "Plugins", "project", False),
        (Path(engine_root_value) / "Engine" / "Plugins", "engine", True),
    ]
    root_specs.extend(
        (Path(value), "external-%d" % index, True)
        for index, value in enumerate(external_root_values, start=1)
    )
    locations: List[PluginLocation] = []
    seen_directories: set[str] = set()
    for root, scope, missing_is_error in root_specs:
        discovered, scan_issues = _scan_plugin_root(
            root,
            scope,
            missing_is_error=missing_is_error,
        )
        issues.extend(scan_issues)
        for location in discovered:
            try:
                canonical_key = str(location.directory.resolve(strict=True)).casefold()
            except (OSError, RuntimeError):
                issues.append(
                    DoctorIssue(
                        reason_code="scan_root_unreadable",
                        message="A discovered plugin directory could not be canonicalized.",
                        plugin_name=scope,
                        scope=scope,
                    )
                )
                continue
            if canonical_key not in seen_directories:
                seen_directories.add(canonical_key)
                locations.append(location)

    core_locations = [
        location
        for location in locations
        if any(name.casefold() == CORE_PLUGIN_NAME.casefold() for name in location.descriptor_names)
    ]
    core_version: Optional[str] = None
    core_state = "present"
    if not core_locations:
        core_state = "missing"
        issues.append(
            DoctorIssue(
                reason_code="core_missing",
                message="UnrealEditorWebUI core plugin was not found in the explicit roots.",
                plugin_name=CORE_PLUGIN_NAME,
            )
        )
    elif len(core_locations) > 1:
        core_state = "duplicate"
        issues.append(
            DoctorIssue(
                reason_code="core_duplicate",
                message="Multiple UnrealEditorWebUI core plugin copies were found.",
                plugin_name=CORE_PLUGIN_NAME,
            )
        )
    else:
        core_location = core_locations[0]
        if core_location.descriptor_names != (CORE_PLUGIN_NAME,):
            core_state = "invalid"
            issues.append(
                DoctorIssue(
                    reason_code="core_descriptor_invalid",
                    message="Core plugin directory must contain exactly one correctly-cased descriptor.",
                    plugin_name=CORE_PLUGIN_NAME,
                    scope=core_location.scope,
                )
            )
        else:
            try:
                core_descriptor = _read_plugin_descriptor(
                    core_location.directory,
                    CORE_PLUGIN_NAME,
                )
                version_value = core_descriptor.get("VersionName")
                if (
                    not isinstance(version_value, str)
                    or _PLUGIN_VERSION_PATTERN.fullmatch(version_value) is None
                ):
                    raise DistributionError(
                        "core_descriptor_invalid",
                        "Core plugin VersionName is missing or invalid.",
                        plugin_name=CORE_PLUGIN_NAME,
                    )
                core_version = version_value
                if _module_names(core_descriptor, CORE_PLUGIN_NAME):
                    _code_plugin_variant(
                        core_location.directory,
                        core_descriptor,
                        CORE_PLUGIN_NAME,
                        engine,
                    )
            except DistributionError as exc:
                core_state = "invalid"
                core_version = None
                issues.append(
                    DoctorIssue(
                        reason_code=exc.reason_code,
                        message=exc.message,
                        plugin_name=CORE_PLUGIN_NAME,
                        scope=core_location.scope,
                    )
                )

    tool_pack_locations: List[PluginLocation] = []
    case_invalid_directories: set[str] = set()
    for location in locations:
        if location in core_locations:
            continue
        is_candidate, exact_case, has_contract, has_distribution = (
            _tool_pack_candidate(location.directory)
        )
        if not is_candidate:
            continue
        tool_pack_locations.append(location)
        safe_name = "candidate"
        if len(location.descriptor_names) == 1:
            descriptor_name = location.descriptor_names[0]
            if _PLUGIN_NAME_PATTERN.fullmatch(descriptor_name) is not None:
                safe_name = descriptor_name
        if has_distribution and (
            not has_contract or len(location.descriptor_names) != 1
        ):
            issues.append(
                DoctorIssue(
                    reason_code="distribution_orphaned",
                    message=(
                        "Published Tool Pack distribution metadata is orphaned from "
                        "its required contract or plugin descriptor."
                    ),
                    plugin_name=safe_name,
                    scope=location.scope,
                )
            )
        if not exact_case:
            case_invalid_directories.add(str(location.directory).casefold())
            issues.append(
                DoctorIssue(
                    reason_code="payload_path_case_invalid",
                    message="Tool Pack required paths must use exact portable casing.",
                    plugin_name=safe_name,
                    scope=location.scope,
                )
            )
    tool_pack_directories = [location.directory for location in tool_pack_locations]
    validation_report = validate_tool_pack_directories(tool_pack_directories)
    public_plugin_names: Dict[str, str] = {}
    for location in tool_pack_locations:
        if len(location.descriptor_names) == 1:
            name = location.descriptor_names[0]
            if _PLUGIN_NAME_PATTERN.fullmatch(name) is not None:
                public_plugin_names[name.casefold()] = name
    issues.extend(
        _doctor_issue_from_validation(issue, public_plugin_names)
        for issue in validation_report.issues
    )
    conflict_free_plugin_names = {
        descriptor.plugin_name.casefold()
        for descriptor in validation_report.descriptors
    }

    location_by_plugin: Dict[str, List[PluginLocation]] = {}
    for location in tool_pack_locations:
        for descriptor_name in location.descriptor_names:
            location_by_plugin.setdefault(descriptor_name.casefold(), []).append(location)

    pack_records: List[DoctorPack] = []
    any_integrity_failure = False
    any_authenticity_failure = False
    anchored_pack_count = 0
    for directory_result in validation_report.directory_results:
        descriptor = directory_result.descriptor
        if not directory_result.valid or descriptor is None:
            pack_records.append(
                DoctorPack(
                    pack_id=None,
                    plugin_name=public_plugin_names.get(
                        directory_result.plugin_name.casefold(),
                        "candidate",
                    ),
                    plugin_version=None,
                    required_core_api=None,
                    state="rejected",
                    integrity_status="not_checked",
                    authenticity_status="unverified",
                )
            )
            any_integrity_failure = True
            continue
        matching_locations = location_by_plugin.get(descriptor.plugin_name.casefold(), [])
        if len(matching_locations) != 1:
            pack_records.append(
                DoctorPack(
                    pack_id=descriptor.pack_id,
                    plugin_name=descriptor.plugin_name,
                    plugin_version=descriptor.plugin_version,
                    required_core_api=descriptor.required_core_api,
                    state="rejected",
                    integrity_status="not_checked",
                    authenticity_status="unverified",
                )
            )
            any_integrity_failure = True
            continue
        location = matching_locations[0]
        integrity_status = "self_consistent"
        authenticity_status = "unverified"
        state = "healthy"
        try:
            _document, manifest_bytes, _records, _variant = _distribution_document(
                location.directory,
                descriptor,
                engine,
            )
            manifest_sha256 = _sha256_bytes(manifest_bytes)
            if trust_anchors is not None:
                expected_digest = trust_anchors.get(descriptor.pack_id)
                if expected_digest is None:
                    raise DistributionError(
                        "trust_anchor_missing",
                        "Trust lock does not contain this installed Tool Pack.",
                        plugin_name=descriptor.plugin_name,
                    )
                if expected_digest != manifest_sha256:
                    raise DistributionError(
                        "trusted_manifest_mismatch",
                        "Installed distribution manifest does not match the trust lock.",
                        plugin_name=descriptor.plugin_name,
                    )
                authenticity_status = "verified"
                anchored_pack_count += 1
        except DistributionError as exc:
            state = "rejected"
            if exc.reason_code in ("trust_anchor_missing", "trusted_manifest_mismatch"):
                authenticity_status = "failed"
                any_authenticity_failure = True
            else:
                integrity_status = "failed"
                any_integrity_failure = True
            issues.append(
                DoctorIssue(
                    reason_code=exc.reason_code,
                    message=exc.message,
                    plugin_name=descriptor.plugin_name,
                    pack_id=descriptor.pack_id,
                    scope=location.scope,
                )
            )
        if (
            descriptor.plugin_name.casefold() not in conflict_free_plugin_names
            or str(location.directory).casefold() in case_invalid_directories
        ):
            state = "rejected"
        pack_records.append(
            DoctorPack(
                pack_id=descriptor.pack_id,
                plugin_name=descriptor.plugin_name,
                plugin_version=descriptor.plugin_version,
                required_core_api=descriptor.required_core_api,
                state=state,
                integrity_status=integrity_status,
                authenticity_status=authenticity_status,
            )
        )

    if trust_anchors is not None:
        installed_ids = {
            pack.pack_id for pack in pack_records if pack.pack_id is not None
        }
        if set(trust_anchors) - installed_ids:
            issues.append(
                DoctorIssue(
                    reason_code="trusted_pack_missing",
                    message="Trust lock names a Tool Pack that is not installed.",
                )
            )
            any_authenticity_failure = True

    bounded_issues, truncated_count = _bounded_issues(issues)
    has_error = any(issue.severity == "error" for issue in bounded_issues)
    overall_status = "unhealthy" if has_error else "healthy"
    if not pack_records:
        integrity_status = "not_checked"
    elif any_integrity_failure:
        integrity_status = "failed"
    else:
        integrity_status = "self_consistent"
    if trust_anchors is None:
        authenticity_status = "unverified"
    elif any_authenticity_failure:
        authenticity_status = "failed"
    elif anchored_pack_count == len([pack for pack in pack_records if pack.pack_id]):
        authenticity_status = "verified"
    else:
        authenticity_status = "unverified"

    pack_records.sort(
        key=lambda pack: (
            (pack.pack_id or "").casefold(),
            pack.plugin_name.casefold(),
            pack.plugin_name,
        )
    )
    return DoctorReport(
        overall_status=overall_status,
        integrity_status=integrity_status,
        authenticity_status=authenticity_status,
        engine=engine.public_document(),
        core={
            "count": len(core_locations),
            "pluginName": CORE_PLUGIN_NAME,
            "pluginVersion": core_version,
            "state": core_state,
        },
        packs=tuple(pack_records),
        issues=bounded_issues,
        truncated_count=truncated_count,
    )


def package_error_document(error: DistributionError) -> Dict[str, Any]:
    return {
        "issues": [
            {
                "message": error.message,
                "pluginName": error.plugin_name,
                "reasonCode": error.reason_code,
            }
        ],
        "schemaVersion": 1,
        "valid": False,
    }


def doctor_error_document(error: DistributionError) -> Dict[str, Any]:
    return {
        "authenticityStatus": "unverified",
        "core": {
            "count": 0,
            "pluginName": CORE_PLUGIN_NAME,
            "pluginVersion": None,
            "state": "unknown",
        },
        "diagnostics": [
            DoctorIssue(
                reason_code=error.reason_code,
                message=error.message,
                plugin_name=error.plugin_name,
            ).public_document()
        ],
        "engine": {
            "buildId": None,
            "platform": PLATFORM_NAME,
            "version": None,
        },
        "integrityStatus": "not_checked",
        "overallStatus": "error",
        "packs": [],
        "schemaVersion": 1,
        "truncatedCount": 0,
    }


def doctor_internal_error_document() -> Dict[str, Any]:
    return doctor_error_document(
        DistributionError(
            "internal_error",
            "Tool Pack doctor failed unexpectedly.",
            plugin_name="internal",
        )
    )


def internal_error_document(tool: str) -> Dict[str, Any]:
    return {
        "issues": [
            {
                "message": "%s failed unexpectedly." % tool,
                "pluginName": "internal",
                "reasonCode": "internal_error",
            }
        ],
        "schemaVersion": 1,
        "valid": False,
    }


def render_json(value: Any) -> str:
    return _canonical_json_bytes(value).decode("utf-8")


def render_package_human(result: PackageResult) -> str:
    return (
        "OK %s (%s)\n"
        "Created %s\n"
        "SHA-256 %s\n"
        % (
            result.descriptor.plugin_name,
            result.descriptor.pack_id,
            result.archive_name,
            result.archive_sha256,
        )
    )


def render_doctor_human(report: DoctorReport) -> str:
    lines: List[str] = []
    for pack in report.packs:
        lines.append(
            "%s %s (%s)"
            % (
                "OK" if pack.state == "healthy" else "REJECTED",
                pack.plugin_name,
                pack.pack_id or "unknown",
            )
        )
    for issue in report.issues:
        lines.append(
            "%s %s [%s] %s"
            % (
                "ERROR" if issue.severity == "error" else "WARNING",
                _safe_label(issue.plugin_name, "unknown-plugin"),
                issue.reason_code,
                issue.message,
            )
        )
    lines.append(
        "Installation %s; integrity=%s; authenticity=%s."
        % (
            report.overall_status,
            report.integrity_status,
            report.authenticity_status,
        )
    )
    return "\n".join(lines) + "\n"


__all__ = [
    "DISTRIBUTION_RELATIVE_PATH",
    "DistributionError",
    "DoctorReport",
    "PackageResult",
    "doctor_installation",
    "doctor_error_document",
    "doctor_internal_error_document",
    "internal_error_document",
    "package_error_document",
    "package_tool_pack",
    "render_doctor_human",
    "render_json",
    "render_package_human",
]
