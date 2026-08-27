#!/usr/bin/env python3
"""Offline Rez payload staging and mandatory Unreal launch preflight.

The module intentionally uses only the Python standard library plus the
repository's existing Tool Pack validator.  It never downloads, compiles, or
installs Python packages.  Rez recipes call :func:`build_from_environment`;
the installed core package exposes the same CLI through ``rez-python``.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence


LOCK_FORMAT = "unreal-editor-webui-rez-payload-lock"
LOCK_SCHEMA_VERSION = 1
RECEIPT_FORMAT = "unreal-editor-webui-rez-payload"
RECEIPT_SCHEMA_VERSION = 1
CORE_PACKAGE = "unreal_editor_webui"
CORE_PLUGIN = "UnrealEditorWebUI"
CORE_VERSION = "0.3.0"
AGGREGATE_VERSION = "1.0.0"
PLATFORM = "windows"
ARCH = "AMD64"
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_JSON_DEPTH = 64
MAX_ARCHIVE_FILES = 20_000
MAX_ARCHIVE_ENTRY_BYTES = 2 * 1024 * 1024 * 1024
MAX_ARCHIVE_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
MAX_TREE_DEPTH = 64
MAX_TREE_FILES = 20_000
MAX_TREE_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
CHUNK_SIZE = 1024 * 1024
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)

TOOL_PACK_RECIPES = {
    "unreal_editor_webui_asset_tools": {
        "packId": "com.openai.fixture.asset-tools",
        "pluginName": "AssetToolsFixture",
        "pluginVersion": "1.0.0",
    },
    "unreal_editor_webui_level_tools": {
        "packId": "com.openai.fixture.level-tools",
        "pluginName": "LevelToolsFixture",
        "pluginVersion": "1.0.0",
    },
}

RESOLVED_PACKAGE_ENV = {
    CORE_PACKAGE: "REZ_UNREAL_EDITOR_WEBUI_ROOT",
    "unreal_editor_webui_asset_tools": "REZ_UNREAL_EDITOR_WEBUI_ASSET_TOOLS_ROOT",
    "unreal_editor_webui_level_tools": "REZ_UNREAL_EDITOR_WEBUI_LEVEL_TOOLS_ROOT",
}

EXPECTED_VARIANTS = (
    ("ue54", "5.4", "5.4.4", "33043543"),
    ("ue55", "5.5", "5.5.4", "37670630"),
    ("ue58", "5.8", "5.8.0", "55116800"),
)

_SHA256_PATTERN = re.compile(r"sha256:[0-9a-f]{64}\Z")
_SAFE_NAME_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}\Z")
_VERSION_PATTERN = re.compile(r"[0-9]+(?:\.[0-9]+){2}\Z")
_DRIVE_PATTERN = re.compile(r"^[A-Za-z]:")
_WINDOWS_RESERVED = re.compile(
    r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$", re.IGNORECASE
)
_WINDOWS_FORBIDDEN = frozenset('<>:"\\|?*')


class RezPayloadError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class TreeRecord:
    path: str
    size: int
    sha256: str


def _fail(code: str, message: str) -> None:
    raise RezPayloadError(code, message)


def _exact_keys(value: Any, keys: set[str], label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        _fail("schema_invalid", f"{label} contains an unexpected or missing field.")
    return value


def _duplicates_rejected(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("json_invalid", "JSON contains duplicate object keys.")
        result[key] = value
    return result


def canonical_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def _reject_json_constant(_value: str) -> None:
    _fail("json_invalid", "JSON contains a non-finite numeric value.")


def _validate_json_shape(value: Any) -> None:
    pending: list[tuple[Any, int]] = [(value, 0)]
    while pending:
        item, depth = pending.pop()
        if depth > MAX_JSON_DEPTH:
            _fail("json_invalid", "JSON exceeds the nesting-depth limit.")
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
        elif isinstance(item, float) and not math.isfinite(item):
            _fail("json_invalid", "JSON contains a non-finite numeric value.")


def _read_regular_bytes(path: Path, label: str, limit: int) -> bytes:
    try:
        before = path.lstat()
    except OSError as exc:
        raise RezPayloadError("file_unreadable", f"{label} is missing or unreadable.") from exc
    if _is_reparse(before) or not stat.S_ISREG(before.st_mode) or before.st_size > limit:
        _fail("file_invalid", f"{label} must be one bounded regular file.")
    try:
        with path.open("rb") as source:
            data = source.read(limit + 1)
            after = os.fstat(source.fileno())
    except OSError as exc:
        raise RezPayloadError("file_unreadable", f"{label} could not be read.") from exc
    if len(data) > limit or before.st_size != len(data) or after.st_size != before.st_size:
        _fail("file_changed", f"{label} changed while it was read.")
    return data


def _read_json(path: Path, label: str, limit: int = MAX_JSON_BYTES) -> Any:
    raw = _read_regular_bytes(path, label, limit)
    try:
        text = raw.decode("utf-8-sig")
        value = json.loads(
            text,
            object_pairs_hook=_duplicates_rejected,
            parse_constant=_reject_json_constant,
        )
        _validate_json_shape(value)
        return value
    except RezPayloadError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise RezPayloadError("json_invalid", f"{label} is not strict UTF-8 JSON.") from exc


def _read_canonical_json(path: Path, label: str) -> tuple[Mapping[str, Any], bytes]:
    raw = _read_regular_bytes(path, label, MAX_JSON_BYTES)
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_duplicates_rejected,
            parse_constant=_reject_json_constant,
        )
        _validate_json_shape(value)
    except RezPayloadError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise RezPayloadError("json_invalid", f"{label} is not canonical JSON.") from exc
    if not isinstance(value, dict) or canonical_json_bytes(value) != raw:
        _fail("json_not_canonical", f"{label} must use canonical JSON bytes.")
    return value, raw


def _sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    before = path.lstat()
    if _is_reparse(before) or not stat.S_ISREG(before.st_mode):
        _fail("archive_invalid", "Payload archive must be a regular file.")
    digest = hashlib.sha256()
    count = 0
    with path.open("rb") as source:
        while True:
            chunk = source.read(CHUNK_SIZE)
            if not chunk:
                break
            count += len(chunk)
            digest.update(chunk)
        after = os.fstat(source.fileno())
    if count != before.st_size or after.st_size != before.st_size:
        _fail("archive_changed", "Payload archive changed while it was hashed.")
    return "sha256:" + digest.hexdigest()


def _is_reparse(value: os.stat_result) -> bool:
    attributes = getattr(value, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse) or stat.S_ISLNK(value.st_mode)


def _same_file_snapshot(left: os.stat_result, right: os.stat_result) -> bool:
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    return all(getattr(left, field, None) == getattr(right, field, None) for field in fields)


def _real_directory(path: Path, label: str) -> Path:
    if ";" in str(path):
        _fail("path_invalid", f"{label} cannot contain a semicolon.")
    try:
        value = path.lstat()
        canonical = path.resolve(strict=True)
    except OSError as exc:
        raise RezPayloadError("path_invalid", f"{label} is missing or unreadable.") from exc
    if _is_reparse(value) or not stat.S_ISDIR(value.st_mode):
        _fail("path_invalid", f"{label} must be one real directory.")
    return canonical


def _portable_key(path: str) -> str:
    return unicodedata.normalize("NFC", path).casefold()


def _validate_component(component: str) -> None:
    if (
        not component
        or component in {".", ".."}
        or component[-1] in {" ", "."}
        or unicodedata.normalize("NFC", component) != component
        or any(character in _WINDOWS_FORBIDDEN or ord(character) < 32 for character in component)
        or _WINDOWS_RESERVED.fullmatch(component) is not None
    ):
        _fail("path_invalid", "Payload contains a non-portable path component.")


def _validate_relative_path(value: str) -> tuple[str, ...]:
    if (
        not value
        or "\0" in value
        or "\\" in value
        or value.startswith("/")
        or _DRIVE_PATTERN.match(value)
    ):
        _fail("path_invalid", "Payload path must be relative portable UTF-8.")
    parts = PurePosixPath(value).parts
    if not parts:
        _fail("path_invalid", "Payload path is empty.")
    for component in parts:
        _validate_component(component)
    return parts


def _tree_digest(records: Iterable[TreeRecord]) -> str:
    # This is the canonical #111 algorithm: path\0size\0sha256\n.
    digest = hashlib.sha256()
    for record in records:
        digest.update(record.path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(record.size).encode("ascii"))
        digest.update(b"\0")
        digest.update(record.sha256.encode("ascii"))
        digest.update(b"\n")
    return "sha256:" + digest.hexdigest()


def snapshot_tree(root: Path) -> tuple[tuple[TreeRecord, ...], str]:
    try:
        root_stat = root.lstat()
    except OSError as exc:
        raise RezPayloadError("tree_unreadable", "Payload tree is missing.") from exc
    if _is_reparse(root_stat) or not stat.S_ISDIR(root_stat.st_mode):
        _fail("tree_invalid", "Payload tree root must be a real directory.")
    pending: list[tuple[Path, str, int]] = [(root, "", 0)]
    records: list[TreeRecord] = []
    keys: dict[str, str] = {}
    total = 0
    while pending:
        directory, relative_directory, depth = pending.pop()
        if depth > MAX_TREE_DEPTH:
            _fail("tree_limit", "Payload tree exceeds the depth limit.")
        try:
            entries = list(os.scandir(directory))
        except OSError as exc:
            raise RezPayloadError("tree_unreadable", "Payload tree cannot be enumerated.") from exc
        entries.sort(key=lambda item: item.name.encode("utf-8"))
        for entry in entries:
            relative = f"{relative_directory}/{entry.name}" if relative_directory else entry.name
            _validate_relative_path(relative)
            key = _portable_key(relative)
            if key in keys and keys[key] != relative:
                _fail("path_collision", "Payload paths collide on a portable filesystem.")
            keys[key] = relative
            value = entry.stat(follow_symlinks=False)
            if _is_reparse(value):
                _fail("reparse_point", "Payload tree contains a reparse point or symbolic link.")
            if stat.S_ISDIR(value.st_mode):
                pending.append((Path(entry.path), relative, depth + 1))
                continue
            if not stat.S_ISREG(value.st_mode):
                _fail("special_file", "Payload tree contains a special file.")
            if len(records) >= MAX_TREE_FILES or value.st_size > MAX_ARCHIVE_ENTRY_BYTES:
                _fail("tree_limit", "Payload tree exceeds a bounded file limit.")
            digest = hashlib.sha256()
            count = 0
            with open(entry.path, "rb") as source:
                while True:
                    chunk = source.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    count += len(chunk)
                    digest.update(chunk)
                after = os.fstat(source.fileno())
            if count != value.st_size or after.st_size != value.st_size:
                _fail("tree_changed", "Payload file changed while it was hashed.")
            total += count
            if total > MAX_TREE_TOTAL_BYTES:
                _fail("tree_limit", "Payload tree exceeds the total-size limit.")
            records.append(TreeRecord(relative, count, "sha256:" + digest.hexdigest()))
    records.sort(key=lambda item: item.path.encode("utf-8"))
    return tuple(records), _tree_digest(records)


def _registry_path() -> Path:
    installed = Path(__file__).resolve().with_name("ue-release-variants.json")
    if installed.is_file():
        return installed
    return Path(__file__).resolve().parents[1] / "scripts" / "ue-release-variants.json"


def load_variants() -> tuple[Mapping[str, Any], ...]:
    document = _read_json(_registry_path(), "UE release variant registry")
    _exact_keys(document, {"schemaVersion", "variants"}, "variant registry")
    variants = document.get("variants")
    if document.get("schemaVersion") != 1 or not isinstance(variants, list) or len(variants) != 3:
        _fail("registry_invalid", "Exactly three schema-1 UE variants are required.")
    for index, expected in enumerate(EXPECTED_VARIANTS):
        variant = variants[index]
        if not isinstance(variant, dict) or not isinstance(variant.get("engine"), dict):
            _fail("registry_invalid", "UE variant record is malformed.")
        variant_id, association, full_version, build_id = expected
        engine = variant["engine"]
        actual_full = f"{engine.get('majorVersion')}.{engine.get('minorVersion')}.{engine.get('patchVersion')}"
        if (
            variant.get("id") != variant_id
            or variant.get("engineAssociation") != association
            or variant.get("releaseVariant") != f"UE{variant_id[2:]}-Win64"
            or actual_full != full_version
            or engine.get("buildId") != build_id
        ):
            _fail("registry_invalid", "UE variant registry lost its closed identity mapping.")
    return tuple(variants)


def _registry_sha256() -> str:
    return _sha256_bytes(_read_regular_bytes(_registry_path(), "UE release variant registry", MAX_JSON_BYTES))


def _safe_archive_file(value: Any) -> str:
    if not isinstance(value, str) or Path(value).name != value or not value.endswith(".zip"):
        _fail("lock_invalid", "Archive name must be one safe ZIP basename.")
    _validate_component(value)
    return value


def _require_digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or _SHA256_PATTERN.fullmatch(value) is None:
        _fail("lock_invalid", f"{label} must be one lowercase SHA-256 digest.")
    return value


def validate_lock(document: Mapping[str, Any]) -> Mapping[str, Any]:
    _exact_keys(
        document,
        {"core", "format", "registrySha256", "schemaVersion", "toolPacks"},
        "payload lock",
    )
    if document.get("format") != LOCK_FORMAT or document.get("schemaVersion") != LOCK_SCHEMA_VERSION:
        _fail("lock_invalid", "Payload lock format or schema is unsupported.")
    if document.get("registrySha256") != _registry_sha256():
        _fail("lock_registry_mismatch", "Payload lock targets a different UE variant registry.")
    core = document.get("core")
    packs = document.get("toolPacks")
    if not isinstance(core, list) or not isinstance(packs, list):
        _fail("lock_invalid", "Payload lock core and Tool Pack records must be arrays.")
    if len(core) != 3 or len(packs) != len(TOOL_PACK_RECIPES):
        _fail("lock_invalid", "Payload lock must contain the closed core and Tool Pack sets.")
    variants = load_variants()
    archive_names: list[str] = []
    for index, record in enumerate(core):
        _exact_keys(
            record,
            {
                "archiveFile",
                "archiveSha256",
                "finalTreeSha256",
                "pluginName",
                "pluginVersion",
                "variantId",
            },
            f"core[{index}]",
        )
        variant = variants[index]
        if (
            record.get("variantId") != variant["id"]
            or record.get("pluginName") != CORE_PLUGIN
            or record.get("pluginVersion") != CORE_VERSION
        ):
            _fail("lock_invalid", "Core lock identity does not match its exact variant.")
        archive_names.append(_safe_archive_file(record.get("archiveFile")))
        _require_digest(record.get("archiveSha256"), "Core archive digest")
        _require_digest(record.get("finalTreeSha256"), "Core final-tree digest")
    for index, (recipe, identity) in enumerate(TOOL_PACK_RECIPES.items()):
        record = packs[index]
        _exact_keys(
            record,
            {
                "archiveFile",
                "archiveSha256",
                "finalTreeSha256",
                "packId",
                "pluginName",
                "pluginVersion",
                "recipe",
            },
            f"toolPacks[{index}]",
        )
        if (
            record.get("recipe") != recipe
            or record.get("packId") != identity["packId"]
            or record.get("pluginName") != identity["pluginName"]
            or record.get("pluginVersion") != identity["pluginVersion"]
        ):
            _fail("lock_invalid", "Tool Pack lock identity is not the closed recipe set.")
        archive_names.append(_safe_archive_file(record.get("archiveFile")))
        _require_digest(record.get("archiveSha256"), "Tool Pack archive digest")
        _require_digest(record.get("finalTreeSha256"), "Tool Pack final-tree digest")
    if len({_portable_key(name) for name in archive_names}) != len(archive_names):
        _fail("lock_invalid", "Payload lock archive basenames must be globally unique.")
    return document


def load_lock(path: Path, expected_sha256: str) -> Mapping[str, Any]:
    document, raw = _read_canonical_json(path, "Rez payload lock")
    expected = _require_digest(expected_sha256, "Payload-lock digest")
    if _sha256_bytes(raw) != expected:
        _fail("lock_hash_mismatch", "Rez payload lock bytes do not match the fixed digest.")
    return validate_lock(document)


def _safe_extract(
    archive_path: Path,
    destination: Path,
    expected_plugin: str,
    *,
    expected_archive_sha256: str | None = None,
) -> tuple[Path, str]:
    if destination.exists() or os.path.lexists(str(destination)):
        _fail("destination_not_fresh", "Extraction destination must not already exist.")
    extractor_path = Path(__file__).resolve().with_name("extract-verified-artifact.py")
    if not extractor_path.is_file():
        extractor_path = Path(__file__).resolve().parents[1] / "scripts" / "extract-verified-artifact.py"
    spec = importlib.util.spec_from_file_location("uewebui_verified_extractor", extractor_path)
    if spec is None or spec.loader is None:
        _fail("extractor_missing", "Verified artifact extractor is unavailable.")
    extractor = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = extractor
    try:
        spec.loader.exec_module(extractor)
        limits = extractor.PROFILE_LIMITS["package"]
        archive_file, archive_stat = extractor._open_regular_archive(archive_path, limits)
        with archive_file:
            digest = hashlib.sha256()
            count = 0
            while True:
                chunk = archive_file.read(CHUNK_SIZE)
                if not chunk:
                    break
                count += len(chunk)
                digest.update(chunk)
            after_hash = os.fstat(archive_file.fileno())
            if count != archive_stat.st_size or not _same_file_snapshot(archive_stat, after_hash):
                _fail("archive_changed", "Payload archive changed while it was hashed.")
            archive_sha256 = "sha256:" + digest.hexdigest()
            if (
                expected_archive_sha256 is not None
                and archive_sha256 != _require_digest(
                    expected_archive_sha256, "Locked archive digest"
                )
            ):
                _fail(
                    "archive_hash_mismatch",
                    "Local precompiled ZIP does not match the payload lock.",
                )
            archive_file.seek(0)
            with zipfile.ZipFile(archive_file, "r") as archive:
                prepared, _total = extractor._preflight(archive, limits)
                for entry in prepared:
                    if entry.parts[0] != expected_plugin:
                        _fail("archive_root_mismatch", "Payload ZIP has the wrong plugin root.")
                    if len(entry.parts) > MAX_TREE_DEPTH + 1:
                        _fail("archive_limit", "Payload ZIP exceeds the path-depth limit.")
                destination.mkdir(parents=True)
                written = 0
                for entry in prepared:
                    if entry.is_directory:
                        extractor._ensure_directory(destination, entry.parts)
                        continue
                    parent = extractor._ensure_directory(destination, entry.parts[:-1])
                    written = extractor._stream_file(
                        archive,
                        entry,
                        parent / entry.parts[-1],
                        limits,
                        written,
                    )
            after_extract = os.fstat(archive_file.fileno())
            if not _same_file_snapshot(archive_stat, after_extract):
                _fail("archive_changed", "Payload archive changed during verified extraction.")
    except RezPayloadError:
        shutil.rmtree(destination, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(destination, ignore_errors=True)
        raise RezPayloadError("archive_invalid", "Payload is not a readable bounded ZIP.") from exc
    plugin = destination / expected_plugin
    if not plugin.is_dir():
        _fail("archive_root_mismatch", "Payload ZIP did not create the expected plugin directory.")
    return plugin, archive_sha256


def _remove_core_build_inputs(plugin: Path) -> None:
    plugin_root = plugin.resolve(strict=True)
    for name in ("Source", "Intermediate"):
        path = plugin / name
        if not os.path.lexists(str(path)):
            continue
        value = path.lstat()
        if _is_reparse(value) or not stat.S_ISDIR(value.st_mode):
            _fail("core_build_input_invalid", "Core build input is not a regular directory.")
        if path.resolve(strict=True).parent != plugin_root:
            _fail("core_build_input_escape", "Core build input escaped the plugin root.")
        shutil.rmtree(path)


def _validate_core(
    plugin: Path,
    variant: Mapping[str, Any],
    *,
    strip_build_inputs: bool = False,
) -> str:
    if strip_build_inputs:
        _remove_core_build_inputs(plugin)
    descriptor = _read_json(plugin / f"{CORE_PLUGIN}.uplugin", "Core plugin descriptor")
    if not isinstance(descriptor, dict):
        _fail("core_descriptor_invalid", "Core plugin descriptor is not an object.")
    expected_engine = f"{variant['engineAssociation']}.0"
    if (
        descriptor.get("VersionName") != CORE_VERSION
        or descriptor.get("Installed") is not True
        or descriptor.get("EngineVersion") != expected_engine
    ):
        _fail("core_variant_mismatch", "Core descriptor does not match the locked UE variant.")
    binaries = plugin / "Binaries" / "Win64"
    try:
        manifests = [item for item in binaries.iterdir() if item.is_file() and item.name.endswith(".modules")]
    except OSError as exc:
        raise RezPayloadError("core_binary_missing", "Core Win64 binaries are missing.") from exc
    if len(manifests) != 1 or manifests[0].name != "UnrealEditor.modules":
        _fail("core_module_manifest_invalid", "Core must contain exactly one canonical module manifest.")
    modules = _read_json(manifests[0], "Core module manifest")
    if not isinstance(modules, dict) or set(modules) != {"BuildId", "Modules"}:
        _fail("core_module_manifest_invalid", "Core module manifest schema is invalid.")
    mapping = modules.get("Modules")
    expected_dll = "UnrealEditor-UnrealEditorWebUI.dll"
    if (
        modules.get("BuildId") != variant["engine"]["buildId"]
        or mapping != {CORE_PLUGIN: expected_dll}
    ):
        _fail("core_variant_mismatch", "Core module BuildId or mapping is for another UE variant.")
    dll = binaries / expected_dll
    if not dll.is_file() or dll.stat().st_size <= 0:
        _fail("core_binary_missing", "Core module DLL is missing or empty.")
    for relative in (
        "LICENSE",
        "Python/unreal_editor_webui_registry.py",
        "SourceManifest.json",
        "Web/dist/index.html",
    ):
        if not (plugin / PurePosixPath(relative)).is_file():
            _fail("core_payload_incomplete", "Core precompiled payload is incomplete.")
    _, tree_sha256 = snapshot_tree(plugin)
    return tree_sha256


def _tooling_paths() -> tuple[Path, Path]:
    here = Path(__file__).resolve().parent
    installed_distribution = here / "tool_pack_distribution.py"
    if installed_distribution.is_file():
        return here, here
    repository = here.parent
    return repository / "scripts", repository / "Python"


def _validate_tool_pack(plugin: Path, expected: Mapping[str, Any]) -> tuple[str, str]:
    scripts_path, python_path = _tooling_paths()
    for path in (str(scripts_path), str(python_path)):
        if path not in sys.path:
            sys.path.insert(0, path)
    try:
        from tool_pack_distribution import EngineIdentity, _distribution_document
        from unreal_editor_webui_toolpacks import validate_tool_pack_directory
    except ImportError as exc:
        raise RezPayloadError("validator_missing", "Tool Pack validator is unavailable.") from exc
    result = validate_tool_pack_directory(plugin)
    if not result.valid or result.descriptor is None:
        _fail("tool_pack_invalid", "Tool Pack payload failed its authoritative validator.")
    descriptor = result.descriptor
    if (
        descriptor.pack_id != expected["packId"]
        or descriptor.plugin_name != expected["pluginName"]
        or descriptor.plugin_version != expected["pluginVersion"]
    ):
        _fail("tool_pack_identity_mismatch", "Tool Pack identity does not match its Rez recipe.")
    dummy_engine = EngineIdentity("5.8.0", 5, 8, 0, "55116800")
    _document, _manifest_bytes, _records, variant = _distribution_document(
        plugin, descriptor, dummy_engine
    )
    if variant != {
        "engineVersion": None,
        "kind": "content_only",
        "moduleBuildId": None,
        "platform": None,
        "pluginEngineVersion": None,
    }:
        _fail("tool_pack_variant_invalid", "Rez example Tool Packs must be content-only.")
    _, tree_sha256 = snapshot_tree(plugin)
    return tree_sha256, descriptor.pack_id


def create_deterministic_archive(
    plugin: Path,
    output: Path,
    *,
    archive_root_name: str | None = None,
) -> str:
    if output.exists() or os.path.lexists(str(output)):
        _fail("output_not_fresh", "Archive output must not already exist.")
    archive_root = archive_root_name or plugin.name
    if _SAFE_NAME_PATTERN.fullmatch(archive_root) is None:
        _fail("plugin_name_invalid", "Plugin directory name is invalid.")
    records, _ = snapshot_tree(plugin)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    if temporary.exists() or os.path.lexists(str(temporary)):
        _fail("output_not_fresh", "Private archive output already exists.")
    try:
        with zipfile.ZipFile(temporary, "x", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
            for record in records:
                info = zipfile.ZipInfo(f"{archive_root}/{record.path}", ZIP_TIMESTAMP)
                info.compress_type = zipfile.ZIP_STORED
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                with archive.open(info, "w", force_zip64=False) as target, (plugin / PurePosixPath(record.path)).open("rb") as source:
                    shutil.copyfileobj(source, target, CHUNK_SIZE)
        os.rename(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()
    return _sha256_file(output)


def _inspect_archive(archive: Path, plugin_name: str, *, variant: Mapping[str, Any] | None, pack_identity: Mapping[str, Any] | None) -> tuple[str, str]:
    with tempfile.TemporaryDirectory(prefix="uewebui-rez-inspect-") as temporary:
        extracted = Path(temporary) / "extracted"
        plugin, archive_sha = _safe_extract(archive, extracted, plugin_name)
        if variant is not None:
            tree_sha = _validate_core(plugin, variant, strip_build_inputs=True)
        elif pack_identity is not None:
            tree_sha, _ = _validate_tool_pack(plugin, pack_identity)
        else:
            _fail("internal_error", "Archive inspection identity is missing.")
    return archive_sha, tree_sha


def create_lock(core_specs: Mapping[str, Path], pack_specs: Mapping[str, Path]) -> Mapping[str, Any]:
    variants = load_variants()
    if set(core_specs) != {variant["id"] for variant in variants}:
        _fail("lock_input_invalid", "Lock creation requires exactly ue54, ue55, and ue58 core ZIPs.")
    if set(pack_specs) != set(TOOL_PACK_RECIPES):
        _fail("lock_input_invalid", "Lock creation requires the closed two Tool Pack ZIPs.")
    core_records = []
    for variant in variants:
        archive = core_specs[variant["id"]]
        archive_sha, tree_sha = _inspect_archive(
            archive, CORE_PLUGIN, variant=variant, pack_identity=None
        )
        core_records.append(
            {
                "archiveFile": archive.name,
                "archiveSha256": archive_sha,
                "finalTreeSha256": tree_sha,
                "pluginName": CORE_PLUGIN,
                "pluginVersion": CORE_VERSION,
                "variantId": variant["id"],
            }
        )
    pack_records = []
    for recipe, identity in TOOL_PACK_RECIPES.items():
        archive = pack_specs[recipe]
        archive_sha, tree_sha = _inspect_archive(
            archive, identity["pluginName"], variant=None, pack_identity=identity
        )
        pack_records.append(
            {
                "archiveFile": archive.name,
                "archiveSha256": archive_sha,
                "finalTreeSha256": tree_sha,
                "packId": identity["packId"],
                "pluginName": identity["pluginName"],
                "pluginVersion": identity["pluginVersion"],
                "recipe": recipe,
            }
        )
    document = {
        "core": core_records,
        "format": LOCK_FORMAT,
        "registrySha256": _registry_sha256(),
        "schemaVersion": LOCK_SCHEMA_VERSION,
        "toolPacks": pack_records,
    }
    validate_lock(document)
    return document


def _record_for(lock: Mapping[str, Any], kind: str, recipe: str, variant_index: int | None) -> tuple[Mapping[str, Any], Mapping[str, Any] | None]:
    if kind == "core":
        if recipe != CORE_PACKAGE or variant_index not in range(3):
            _fail("variant_invalid", "Core Rez build variant index must be 0, 1, or 2.")
        variants = load_variants()
        return lock["core"][variant_index], variants[variant_index]
    if kind == "tool_pack":
        if variant_index is not None or recipe not in TOOL_PACK_RECIPES:
            _fail("variant_invalid", "Tool Pack Rez build identity is invalid.")
        for record in lock["toolPacks"]:
            if record["recipe"] == recipe:
                return record, None
    _fail("recipe_invalid", "Unknown Rez payload recipe.")


def _receipt(record: Mapping[str, Any], kind: str, recipe: str, variant: Mapping[str, Any] | None) -> Mapping[str, Any]:
    value: dict[str, Any] = {
        "archiveSha256": record["archiveSha256"],
        "finalTreeSha256": record["finalTreeSha256"],
        "format": RECEIPT_FORMAT,
        "kind": kind,
        "packageName": recipe,
        "pluginName": record["pluginName"],
        "pluginVersion": record["pluginVersion"],
        "registrySha256": _registry_sha256(),
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
    }
    if kind == "core":
        value["variantId"] = variant["id"] if variant is not None else None
    else:
        value["packId"] = record["packId"]
    return value


def _copy_core_tools(stage: Path) -> None:
    scripts = stage / "Scripts"
    scripts.mkdir()
    source_scripts, source_python = _tooling_paths()
    sources = {
        "rez_payload.py": Path(__file__).resolve(),
        "tool_pack_distribution.py": source_scripts / "tool_pack_distribution.py",
        "extract-verified-artifact.py": source_scripts / "extract-verified-artifact.py",
        "unreal_editor_webui_toolpacks.py": source_python / "unreal_editor_webui_toolpacks.py",
        "unreal_editor_webui_toolpack_integrity.py": source_python / "unreal_editor_webui_toolpack_integrity.py",
        "ue-release-variants.json": _registry_path(),
    }
    for destination_name, source in sources.items():
        shutil.copyfile(source, scripts / destination_name)
    (scripts / "uewebui-rez-preflight.cmd").write_bytes(
        b'@echo off\r\nrez-python "%~dp0rez_payload.py" preflight %*\r\n'
    )
    (scripts / "uewebui-rez-launch.cmd").write_bytes(
        b'@echo off\r\nrez-python "%~dp0rez_payload.py" launch %*\r\n'
    )
    (scripts / "uewebui-rez-verify.cmd").write_bytes(
        b'@echo off\r\nrez-python "%~dp0rez_payload.py" verify-resolved %*\r\n'
    )


def install_locked_payload(
    lock: Mapping[str, Any],
    payload_root: Path,
    output_root: Path,
    *,
    kind: str,
    recipe: str,
    variant_index: int | None,
) -> Mapping[str, Any]:
    if ";" in str(output_root):
        _fail("path_invalid", "Rez package output root cannot contain a semicolon.")
    record, variant = _record_for(lock, kind, recipe, variant_index)
    archive_name = _safe_archive_file(record["archiveFile"])
    payload_root = _real_directory(payload_root, "Local payload root")
    archive = payload_root / archive_name
    if archive.parent != payload_root:
        _fail("archive_escape", "Locked archive escaped the explicit local payload root.")
    if os.path.lexists(str(output_root)):
        output_stat = output_root.lstat()
        if _is_reparse(output_stat) or not stat.S_ISDIR(output_stat.st_mode):
            _fail("output_not_fresh", "Rez payload output root must be a real directory.")
        if any(output_root.iterdir()):
            _fail("output_not_fresh", "Rez payload output directory must be fresh.")
    output_root.parent.mkdir(parents=True, exist_ok=True)
    _real_directory(output_root.parent, "Rez package output parent")
    with tempfile.TemporaryDirectory(prefix=".uewebui-rez-stage-", dir=output_root.parent) as temporary:
        stage = Path(temporary) / "package"
        extract_root = Path(temporary) / "extract"
        stage.mkdir()
        plugin, _archive_sha = _safe_extract(
            archive,
            extract_root,
            record["pluginName"],
            expected_archive_sha256=record["archiveSha256"],
        )
        if kind == "core":
            actual_tree = _validate_core(plugin, variant, strip_build_inputs=True)
        else:
            actual_tree, _ = _validate_tool_pack(plugin, TOOL_PACK_RECIPES[recipe])
        if actual_tree != record["finalTreeSha256"]:
            _fail("final_tree_hash_mismatch", "Final activated plugin tree does not match the lock.")
        plugins = stage / "Plugins"
        plugins.mkdir()
        os.rename(plugin, plugins / record["pluginName"])
        if kind == "core":
            _copy_core_tools(stage)
        receipt = _receipt(record, kind, recipe, variant)
        (stage / "RezPayload.json").write_bytes(canonical_json_bytes(receipt))
        output_root.mkdir(parents=True, exist_ok=True)
        if any(output_root.iterdir()):
            _fail("output_not_fresh", "Rez payload output was populated during staging.")
        published: list[Path] = []
        try:
            for child in sorted(stage.iterdir(), key=lambda item: item.name.encode("utf-8")):
                target = output_root / child.name
                os.rename(child, target)
                published.append(target)
        except Exception:
            for target in reversed(published):
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
                else:
                    target.unlink(missing_ok=True)
            raise
    verify_installed(output_root)
    return receipt


def _load_receipt(root: Path) -> Mapping[str, Any]:
    receipt, _ = _read_canonical_json(root / "RezPayload.json", "Rez payload receipt")
    common = {
        "archiveSha256",
        "finalTreeSha256",
        "format",
        "kind",
        "packageName",
        "pluginName",
        "pluginVersion",
        "registrySha256",
        "schemaVersion",
    }
    kind = receipt.get("kind")
    expected = common | ({"variantId"} if kind == "core" else {"packId"})
    _exact_keys(receipt, expected, "Rez payload receipt")
    if receipt.get("format") != RECEIPT_FORMAT or receipt.get("schemaVersion") != 1:
        _fail("receipt_invalid", "Rez payload receipt format is unsupported.")
    _require_digest(receipt.get("archiveSha256"), "Receipt archive digest")
    _require_digest(receipt.get("finalTreeSha256"), "Receipt final-tree digest")
    if receipt.get("registrySha256") != _registry_sha256():
        _fail("receipt_registry_mismatch", "Rez payload receipt targets another registry.")
    return receipt


def verify_installed(root: Path) -> Mapping[str, Any]:
    try:
        root_stat = root.lstat()
    except OSError as exc:
        raise RezPayloadError("package_root_invalid", "Rez package root is missing.") from exc
    if _is_reparse(root_stat) or not stat.S_ISDIR(root_stat.st_mode):
        _fail("package_root_invalid", "Rez package root must be one real directory.")
    root = root.resolve(strict=True)
    receipt = _load_receipt(root)
    plugin_name = receipt.get("pluginName")
    if not isinstance(plugin_name, str) or _SAFE_NAME_PATTERN.fullmatch(plugin_name) is None:
        _fail("receipt_invalid", "Rez receipt plugin name is invalid.")
    plugin = root / "Plugins" / plugin_name
    _records, current_tree = snapshot_tree(plugin)
    if current_tree != receipt["finalTreeSha256"]:
        _fail("final_tree_hash_mismatch", "Installed Rez plugin tree has been modified.")
    if receipt["kind"] == "core":
        variants = load_variants()
        matches = [variant for variant in variants if variant["id"] == receipt.get("variantId")]
        if len(matches) != 1 or receipt.get("packageName") != CORE_PACKAGE:
            _fail("receipt_invalid", "Core Rez receipt variant is invalid.")
        tree = _validate_core(plugin, matches[0])
    elif receipt["kind"] == "tool_pack":
        recipe = receipt.get("packageName")
        if recipe not in TOOL_PACK_RECIPES:
            _fail("receipt_invalid", "Tool Pack Rez receipt recipe is invalid.")
        tree, pack_id = _validate_tool_pack(plugin, TOOL_PACK_RECIPES[recipe])
        if pack_id != receipt.get("packId"):
            _fail("receipt_invalid", "Tool Pack Rez receipt id is invalid.")
    else:
        _fail("receipt_invalid", "Rez payload receipt kind is invalid.")
    if tree != receipt["finalTreeSha256"] or tree != current_tree:
        _fail("final_tree_hash_mismatch", "Installed Rez plugin tree has been modified.")
    return receipt


def verify_resolved(package: str) -> Mapping[str, Any]:
    environment_name = RESOLVED_PACKAGE_ENV.get(package)
    if environment_name is None:
        _fail("package_invalid", "Resolved verification package is outside the closed recipe set.")
    raw_root = os.environ.get(environment_name)
    if not isinstance(raw_root, str) or not raw_root.strip():
        _fail("package_root_missing", "Resolved Rez package root environment is missing.")
    root = _real_directory(Path(raw_root), "Resolved Rez package root")
    receipt = verify_installed(root)
    if receipt.get("packageName") != package:
        _fail("package_root_mismatch", "Resolved Rez package root belongs to another recipe.")
    return receipt


def _engine_variant(engine_root: Path) -> Mapping[str, Any]:
    variants = load_variants()
    build = _read_json(engine_root / "Engine" / "Build" / "Build.version", "Unreal Build.version")
    editor = _read_json(
        engine_root / "Engine" / "Binaries" / "Win64" / "UnrealEditor.version",
        "UnrealEditor version manifest",
    )
    editor_modules = _read_json(
        engine_root / "Engine" / "Binaries" / "Win64" / "UnrealEditor.modules",
        "UnrealEditor module manifest",
    )
    if not isinstance(build, dict) or not isinstance(editor, dict) or not isinstance(editor_modules, dict):
        _fail("engine_identity_invalid", "Unreal engine identity files are malformed.")
    matches = []
    for variant in variants:
        engine = variant["engine"]
        identity_matches = all(
            identity.get("MajorVersion") == engine["majorVersion"]
            and identity.get("MinorVersion") == engine["minorVersion"]
            and identity.get("PatchVersion") == engine["patchVersion"]
            and identity.get("Changelist") == engine["changelist"]
            and identity.get("CompatibleChangelist") == engine["compatibleChangelist"]
            and identity.get("BranchName") == engine["branchName"]
            for identity in (build, editor)
        )
        if (
            identity_matches
            and editor.get("BuildId") == engine["buildId"]
            and editor_modules.get("BuildId") == engine["buildId"]
        ):
            matches.append(variant)
    if len(matches) != 1:
        _fail("engine_variant_mismatch", "Unreal engine is not one exact locked UE54/55/58 variant.")
    return matches[0]


def _project_plugins(project: Path) -> Mapping[str, Mapping[str, Any]]:
    document = _read_json(project, "Unreal project descriptor")
    if not isinstance(document, dict) or not isinstance(document.get("Plugins"), list):
        _fail("project_invalid", "Unreal project must contain an explicit Plugins array.")
    plugins: dict[str, Mapping[str, Any]] = {}
    for item in document["Plugins"]:
        if not isinstance(item, dict) or not isinstance(item.get("Name"), str):
            _fail("project_invalid", "Unreal project contains malformed plugin metadata.")
        key = item["Name"].casefold()
        if key in plugins:
            _fail("project_invalid", "Unreal project contains duplicate plugin entries.")
        plugins[key] = item
    return plugins


def _additional_roots(value: str) -> tuple[Path, ...]:
    raw = [item for item in value.split(os.pathsep) if item]
    if not raw:
        _fail("additional_paths_missing", "UE_ADDITIONAL_PLUGIN_PATHS is empty.")
    roots: list[Path] = []
    keys: set[str] = set()
    for item in raw:
        if ";" in item:
            _fail("additional_path_invalid", "Additional plugin roots cannot contain a semicolon.")
        path = Path(item)
        try:
            value_stat = path.lstat()
            canonical = path.resolve(strict=True)
        except OSError as exc:
            raise RezPayloadError("additional_path_invalid", "An additional plugin root is missing.") from exc
        if _is_reparse(value_stat) or not stat.S_ISDIR(value_stat.st_mode):
            _fail("additional_path_invalid", "Additional plugin roots must be real directories.")
        key = os.path.normcase(str(canonical)).casefold()
        if key in keys:
            continue
        keys.add(key)
        roots.append(canonical)
    return tuple(roots)


def _real_project(project: Path) -> Path:
    if ";" in str(project):
        _fail("path_invalid", "Project paths cannot contain semicolons.")
    try:
        project_stat = project.lstat()
    except OSError as exc:
        raise RezPayloadError("project_invalid", "Unreal project descriptor is missing.") from exc
    if _is_reparse(project_stat) or not stat.S_ISREG(project_stat.st_mode):
        _fail("project_invalid", "Unreal project descriptor must be a real file.")
    return project.resolve(strict=True)


def preflight(project: Path, engine_root: Path, additional_paths: str) -> Mapping[str, Any]:
    project = _real_project(project)
    engine_root = _real_directory(engine_root, "Unreal engine root")
    variant = _engine_variant(engine_root)
    roots = _additional_roots(additional_paths)
    receipts: list[Mapping[str, Any]] = []
    for root in roots:
        receipt_path = root.parent / "RezPayload.json"
        if receipt_path.is_file():
            receipt = verify_installed(root.parent)
            if (root.parent / "Plugins").resolve(strict=True) != root:
                _fail("receipt_root_mismatch", "Rez receipt is not bound to its activated Plugins root.")
            receipts.append(receipt)
    cores = [receipt for receipt in receipts if receipt["kind"] == "core"]
    packs = [receipt for receipt in receipts if receipt["kind"] == "tool_pack"]
    if len(cores) != 1 or cores[0].get("variantId") != variant["id"]:
        _fail("core_variant_mismatch", "Resolved core is missing, duplicated, or for another engine.")
    pack_ids = [str(receipt["packId"]) for receipt in packs]
    if len(pack_ids) != len(set(pack_ids)):
        _fail("tool_pack_duplicate", "Resolved Tool Pack receipts contain a duplicate id.")
    plugins = _project_plugins(project)
    core_entry = plugins.get(CORE_PLUGIN.casefold())
    if core_entry is None or core_entry.get("Enabled") is not True or core_entry.get("Optional") is True:
        _fail("project_core_invalid", "Project must explicitly enable the non-optional core plugin.")
    for receipt in packs:
        item = plugins.get(str(receipt["pluginName"]).casefold())
        if item is None or item.get("Enabled") is not True or item.get("Optional") is not True:
            _fail("project_pack_invalid", "Project Tool Packs must be explicitly enabled and optional.")
    scripts_path, python_path = _tooling_paths()
    for path in (str(scripts_path), str(python_path)):
        if path not in sys.path:
            sys.path.insert(0, path)
    try:
        from tool_pack_distribution import doctor_installation
    except ImportError as exc:
        raise RezPayloadError("validator_missing", "Installation doctor is unavailable.") from exc
    report = doctor_installation(project, engine_root, [str(root) for root in roots])
    if not report.healthy or report.core.get("count") != 1 or report.core.get("state") != "present":
        codes = sorted({issue.reason_code for issue in report.issues})
        _fail("installation_unhealthy", "Installation doctor rejected the resolve: " + ",".join(codes))
    doctor_pack_ids = sorted(pack.pack_id for pack in report.packs if pack.pack_id is not None)
    if doctor_pack_ids != sorted(pack_ids) or any(pack.state != "healthy" for pack in report.packs):
        _fail("tool_pack_set_mismatch", "Installed Tool Packs do not exactly match Rez receipts.")
    return {
        "core": CORE_PLUGIN,
        "packIds": sorted(pack_ids),
        "schemaVersion": 1,
        "valid": True,
        "variantId": variant["id"],
    }


def launch(project: Path, engine_root: Path, editor: Path, editor_args: Sequence[str]) -> int:
    additional = os.environ.get("UE_ADDITIONAL_PLUGIN_PATHS", "")
    resolved_project = _real_project(project)
    resolved_engine = _real_directory(engine_root, "Unreal engine root")
    result = preflight(resolved_project, resolved_engine, additional)
    try:
        editor_stat = editor.lstat()
        resolved_editor = editor.resolve(strict=True)
    except OSError as exc:
        raise RezPayloadError("editor_missing", "Requested Unreal Editor executable is missing.") from exc
    expected_parent = resolved_engine / "Engine" / "Binaries" / "Win64"
    if (
        _is_reparse(editor_stat)
        or not stat.S_ISREG(editor_stat.st_mode)
        or resolved_editor.parent != expected_parent
        or resolved_editor.name not in {"UnrealEditor.exe", "UnrealEditor-Cmd.exe"}
    ):
        _fail("editor_missing", "Requested Unreal Editor executable is missing.")
    os.environ["UNREAL_EDITOR_WEBUI_REZ_PREFLIGHT"] = canonical_json_bytes(result).decode("utf-8").strip()
    completed = subprocess.run([str(resolved_editor), str(resolved_project), *editor_args], check=False)
    return int(completed.returncode)


def build_from_environment(kind: str, recipe: str) -> Mapping[str, Any]:
    lock_value = os.environ.get("UNREAL_EDITOR_WEBUI_REZ_PAYLOAD_LOCK", "")
    lock_sha = os.environ.get("UNREAL_EDITOR_WEBUI_REZ_PAYLOAD_LOCK_SHA256", "")
    payload_value = os.environ.get("UNREAL_EDITOR_WEBUI_REZ_PAYLOAD_ROOT", "")
    if not lock_value or not lock_sha or not payload_value:
        _fail("build_input_missing", "Rez build requires an explicit local payload root and fixed lock SHA.")
    lock = load_lock(Path(lock_value), lock_sha)
    variant_index: int | None = None
    if kind == "core":
        raw_index = os.environ.get("REZ_BUILD_VARIANT_INDEX", "")
        if raw_index not in {"0", "1", "2"}:
            _fail("variant_invalid", "Rez, not a user variant variable, must select core variant 0, 1, or 2.")
        variant_index = int(raw_index)
    install = os.environ.get("REZ_BUILD_INSTALL") == "1"
    destination_value = os.environ.get(
        "REZ_BUILD_INSTALL_PATH" if install else "REZ_BUILD_PATH", ""
    )
    if not destination_value:
        _fail("build_output_missing", "Rez did not provide a build output path.")
    destination = Path(destination_value)
    if not install:
        destination = destination / "rez_payload_preview"
    return install_locked_payload(
        lock,
        Path(payload_value),
        destination,
        kind=kind,
        recipe=recipe,
        variant_index=variant_index,
    )


def _parse_assignments(values: Sequence[str], expected: set[str], label: str) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for value in values:
        key, separator, path = value.partition("=")
        if separator != "=" or key not in expected or key in result or not path:
            _fail("argument_invalid", f"{label} assignments must contain the exact closed key set.")
        result[key] = Path(path)
    if set(result) != expected:
        _fail("argument_invalid", f"{label} assignments are incomplete.")
    return result


def _write_fresh(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as output:
            output.write(data)
    except FileExistsError as exc:
        raise RezPayloadError("output_not_fresh", "Output file already exists.") from exc


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Offline UnrealEditorWebUI Rez payload tooling.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    archive = subparsers.add_parser("make-archive")
    archive.add_argument("--plugin-dir", required=True)
    archive.add_argument("--archive-root-name", default=None)
    archive.add_argument("--output", required=True)
    lock = subparsers.add_parser("create-lock")
    lock.add_argument("--core", action="append", default=[])
    lock.add_argument("--tool-pack", action="append", default=[])
    lock.add_argument("--output", required=True)
    install = subparsers.add_parser("install")
    install.add_argument("--kind", choices=("core", "tool_pack"), required=True)
    install.add_argument("--recipe", required=True)
    install.add_argument("--variant-index", type=int)
    install.add_argument("--lock", required=True)
    install.add_argument("--lock-sha256", required=True)
    install.add_argument("--payload-root", required=True)
    install.add_argument("--output-root", required=True)
    verify = subparsers.add_parser("verify-installed")
    verify.add_argument("--package-root", required=True)
    verify_resolve = subparsers.add_parser("verify-resolved")
    verify_resolve.add_argument("--package", choices=tuple(RESOLVED_PACKAGE_ENV), required=True)
    before = subparsers.add_parser("preflight")
    before.add_argument("--project", required=True)
    before.add_argument("--engine-root", required=True)
    before.add_argument("--additional-paths", default=None)
    run = subparsers.add_parser("launch")
    run.add_argument("--project", required=True)
    run.add_argument("--engine-root", required=True)
    run.add_argument("--editor", required=True)
    run.add_argument("editor_args", nargs=argparse.REMAINDER)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
        if args.command == "make-archive":
            digest = create_deterministic_archive(
                Path(args.plugin_dir),
                Path(args.output),
                archive_root_name=args.archive_root_name,
            )
            result: Mapping[str, Any] = {"archiveSha256": digest, "valid": True}
        elif args.command == "create-lock":
            cores = _parse_assignments(args.core, {item[0] for item in EXPECTED_VARIANTS}, "Core")
            packs = _parse_assignments(args.tool_pack, set(TOOL_PACK_RECIPES), "Tool Pack")
            document = create_lock(cores, packs)
            raw = canonical_json_bytes(document)
            _write_fresh(Path(args.output), raw)
            _write_fresh(Path(str(args.output) + ".sha256"), (_sha256_bytes(raw) + "\n").encode("ascii"))
            result = {"lockSha256": _sha256_bytes(raw), "valid": True}
        elif args.command == "install":
            lock = load_lock(Path(args.lock), args.lock_sha256)
            result = install_locked_payload(
                lock,
                Path(args.payload_root),
                Path(args.output_root),
                kind=args.kind,
                recipe=args.recipe,
                variant_index=args.variant_index,
            )
        elif args.command == "verify-installed":
            result = verify_installed(Path(args.package_root))
        elif args.command == "verify-resolved":
            result = verify_resolved(args.package)
        elif args.command == "preflight":
            additional = args.additional_paths
            if additional is None:
                additional = os.environ.get("UE_ADDITIONAL_PLUGIN_PATHS", "")
            result = preflight(Path(args.project), Path(args.engine_root), additional)
        elif args.command == "launch":
            editor_args = list(args.editor_args)
            if editor_args[:1] == ["--"]:
                editor_args = editor_args[1:]
            return launch(
                Path(args.project), Path(args.engine_root), Path(args.editor), editor_args
            )
        else:
            _fail("argument_invalid", "Unknown command.")
        sys.stdout.write(canonical_json_bytes(result).decode("utf-8"))
        return 0
    except RezPayloadError as exc:
        sys.stderr.write(f"ERROR [{exc.code}] {exc.message}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
