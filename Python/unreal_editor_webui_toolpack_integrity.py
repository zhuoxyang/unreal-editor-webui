from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterable


POLICY_FORMAT = "unreal-editor-webui-tool-pack-policy"
POLICY_SCHEMA_VERSION = 1
POLICY_RELATIVE_PATH = (
    Path("Config") / "UnrealEditorWebUI" / "ToolPackPolicy.json"
)
DISTRIBUTION_RELATIVE_PATH = (
    Path("Content") / "UnrealEditorWebUI" / "ToolPackDistribution.json"
)
MAX_POLICY_BYTES = 256 * 1024
MAX_POLICY_DEPTH = 8
MAX_POLICY_PACKS = 256
MAX_CORE_API_VERSION = 2_147_483_647
MAX_PAYLOAD_FILES = 10_000
MAX_PAYLOAD_TREE_DEPTH = 64
MAX_PAYLOAD_SCAN_ENTRIES = 50_000
MAX_SINGLE_FILE_BYTES = 1024 * 1024 * 1024
MAX_TOTAL_FILE_BYTES = 2 * 1024 * 1024 * 1024
STREAM_CHUNK_SIZE = 1024 * 1024

_PACK_ID_PATTERN = re.compile(
    r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+\Z"
)
_PLUGIN_VERSION_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}\Z")
_SHA256_PATTERN = re.compile(r"sha256:[0-9a-f]{64}\Z")
_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")
_WINDOWS_RESERVED = re.compile(
    r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$",
    re.IGNORECASE,
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
_ALLOWED_ROOT_DIRECTORY_KEYS = {
    component.casefold(): component for component in _ALLOWED_ROOT_DIRECTORIES
}
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


class ToolPackIntegrityError(ValueError):
    def __init__(self, reason_code: str, message: str) -> None:
        super().__init__(message)
        self.reason_code = reason_code
        self.message = message


@dataclass(frozen=True)
class ToolPackPayloadFile:
    relative_path: str
    absolute_path: Path
    size: int
    sha256: str
    snapshot_stat: os.stat_result


@dataclass(frozen=True)
class ToolPackPolicyEntry:
    pack_id: str
    plugin_version: str
    required_core_api: int
    payload_sha256: str


@dataclass(frozen=True)
class ToolPackPolicy:
    entries: tuple[ToolPackPolicyEntry, ...]

    @property
    def by_pack_id(self) -> dict[str, ToolPackPolicyEntry]:
        return {entry.pack_id: entry for entry in self.entries}


def _is_reparse_stat(path_stat: os.stat_result) -> bool:
    if stat.S_ISLNK(path_stat.st_mode):
        return True
    attributes = getattr(path_stat, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


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
                raise ToolPackIntegrityError(
                    reason_code,
                    f"{label} exceeds the supported nesting depth.",
                )
        elif character in "]}":
            depth = max(0, depth - 1)


def _strict_json_bytes(
    raw: bytes,
    *,
    label: str,
    max_bytes: int,
    max_depth: int,
    reason_code: str,
) -> Any:
    if not raw or len(raw) > max_bytes:
        raise ToolPackIntegrityError(
            reason_code,
            f"{label} must be non-empty and no larger than {max_bytes} bytes.",
        )
    try:
        document = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ToolPackIntegrityError(
            reason_code,
            f"{label} must use strict UTF-8 JSON.",
        ) from exc
    _validate_raw_json_depth(document, max_depth, reason_code, label)

    def closed_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise ToolPackIntegrityError(
                    reason_code,
                    f"{label} contains a duplicate decoded field.",
                )
            value[key] = item
        return value

    def invalid_constant(_value: str) -> None:
        raise ToolPackIntegrityError(
            reason_code,
            f"{label} must use strict UTF-8 JSON.",
        )

    def assert_finite(value: Any) -> None:
        if isinstance(value, float) and not math.isfinite(value):
            raise ToolPackIntegrityError(
                reason_code,
                f"{label} must use strict UTF-8 JSON.",
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
    except ToolPackIntegrityError:
        raise
    except (json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ToolPackIntegrityError(
            reason_code,
            f"{label} must use strict UTF-8 JSON.",
        ) from exc


def _read_regular_bytes(
    path: Path,
    *,
    label: str,
    max_bytes: int,
    reason_code: str,
) -> bytes:
    try:
        path_stat = path.lstat()
    except OSError as exc:
        raise ToolPackIntegrityError(
            reason_code,
            f"{label} could not be inspected.",
        ) from exc
    if _is_reparse_stat(path_stat) or not stat.S_ISREG(path_stat.st_mode):
        raise ToolPackIntegrityError(
            reason_code,
            f"{label} must be a regular file, not a reparse point.",
        )
    if path_stat.st_size <= 0 or path_stat.st_size > max_bytes:
        raise ToolPackIntegrityError(
            reason_code,
            f"{label} must be non-empty and no larger than {max_bytes} bytes.",
        )
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ToolPackIntegrityError(
            reason_code,
            f"{label} could not be read.",
        ) from exc
    if len(raw) != path_stat.st_size:
        raise ToolPackIntegrityError(
            reason_code,
            f"{label} changed while it was being read.",
        )
    return raw


def read_tool_pack_policy(path: str | os.PathLike[str]) -> ToolPackPolicy:
    policy_path = Path(path)
    raw = _read_regular_bytes(
        policy_path,
        label="Tool Pack project policy",
        max_bytes=MAX_POLICY_BYTES,
        reason_code="trust_policy_invalid",
    )
    value = _strict_json_bytes(
        raw,
        label="Tool Pack project policy",
        max_bytes=MAX_POLICY_BYTES,
        max_depth=MAX_POLICY_DEPTH,
        reason_code="trust_policy_invalid",
    )
    if not isinstance(value, dict) or set(value) != {
        "format",
        "packs",
        "schemaVersion",
    }:
        raise ToolPackIntegrityError(
            "trust_policy_invalid",
            "Tool Pack project policy uses an unsupported closed schema.",
        )
    if (
        value.get("format") != POLICY_FORMAT
        or isinstance(value.get("schemaVersion"), bool)
        or not isinstance(value.get("schemaVersion"), int)
        or value.get("schemaVersion") != POLICY_SCHEMA_VERSION
        or not isinstance(value.get("packs"), list)
        or len(value["packs"]) > MAX_POLICY_PACKS
    ):
        raise ToolPackIntegrityError(
            "trust_policy_invalid",
            "Tool Pack project policy uses an unsupported closed schema.",
        )

    entries: list[ToolPackPolicyEntry] = []
    seen_ids: set[str] = set()
    for item in value["packs"]:
        if not isinstance(item, dict) or set(item) != {
            "packId",
            "payloadSha256",
            "pluginVersion",
            "requiredCoreApi",
        }:
            raise ToolPackIntegrityError(
                "trust_policy_invalid",
                "Tool Pack project policy contains an invalid entry.",
            )
        pack_id = item.get("packId")
        plugin_version = item.get("pluginVersion")
        required_core_api = item.get("requiredCoreApi")
        payload_sha256 = item.get("payloadSha256")
        pack_key = pack_id.casefold() if isinstance(pack_id, str) else ""
        if (
            not isinstance(pack_id, str)
            or len(pack_id) > 128
            or _PACK_ID_PATTERN.fullmatch(pack_id) is None
            or pack_key in seen_ids
            or not isinstance(plugin_version, str)
            or _PLUGIN_VERSION_PATTERN.fullmatch(plugin_version) is None
            or isinstance(required_core_api, bool)
            or not isinstance(required_core_api, int)
            or required_core_api <= 0
            or required_core_api > MAX_CORE_API_VERSION
            or not isinstance(payload_sha256, str)
            or _SHA256_PATTERN.fullmatch(payload_sha256) is None
        ):
            raise ToolPackIntegrityError(
                "trust_policy_invalid",
                "Tool Pack project policy contains an invalid or duplicate entry.",
            )
        seen_ids.add(pack_key)
        entries.append(
            ToolPackPolicyEntry(
                pack_id=pack_id,
                plugin_version=plugin_version,
                required_core_api=required_core_api,
                payload_sha256=payload_sha256,
            )
        )
    entries.sort(key=lambda item: (item.pack_id.casefold(), item.pack_id))
    return ToolPackPolicy(entries=tuple(entries))


def load_project_tool_pack_policy(
    project_directory: str | os.PathLike[str],
) -> ToolPackPolicy | None:
    project_root = Path(project_directory)
    policy_path = project_root / POLICY_RELATIVE_PATH
    try:
        exists = os.path.lexists(policy_path)
    except OSError as exc:
        raise ToolPackIntegrityError(
            "trust_policy_invalid",
            "Tool Pack project policy path could not be inspected.",
        ) from exc
    if not exists:
        return None
    try:
        canonical_root = project_root.resolve(strict=True)
        canonical_policy = policy_path.resolve(strict=True)
        canonical_policy.relative_to(canonical_root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ToolPackIntegrityError(
            "trust_policy_invalid",
            "Tool Pack project policy must stay inside the project directory.",
        ) from exc
    return read_tool_pack_policy(canonical_policy)


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
        raise ToolPackIntegrityError(
            "payload_path_invalid",
            "Tool Pack contains a non-portable payload path.",
        )
    if unicodedata.normalize("NFC", component) != component:
        raise ToolPackIntegrityError(
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
        raise ToolPackIntegrityError(
            "payload_path_invalid",
            "Tool Pack contains a non-portable payload path.",
        )
    for component in relative_path.split("/"):
        _validate_path_component(component)


def _portable_path_key(relative_path: str) -> str:
    return unicodedata.normalize("NFC", relative_path).casefold()


def _validate_payload_path_policy(relative_path: str) -> None:
    components = relative_path.split("/")
    root = components[0]
    name = components[-1]
    component_keys = [component.casefold() for component in components]
    if any(component in _REJECTED_PATH_COMPONENT_KEYS for component in component_keys):
        raise ToolPackIntegrityError(
            "payload_private_file",
            "Tool Pack payload contains a private or transient path.",
        )
    name_key = name.casefold()
    if (
        name_key in {".ds_store", "thumbs.db"}
        or name_key.endswith((".pyc", ".pyo", ".pdb", ".log", ".tmp", ".user"))
        or name_key == ".env"
        or name_key.startswith(".env.")
    ):
        raise ToolPackIntegrityError(
            "payload_private_file",
            "Tool Pack payload contains a private or transient file.",
        )
    if len(components) == 1:
        allowed_root_file = (
            root.casefold().endswith(".uplugin")
            or root in {"LICENSE", "NOTICE", "README.md", "SourceManifest.json"}
        )
        canonical_root_directory = _ALLOWED_ROOT_DIRECTORY_KEYS.get(root.casefold())
        if canonical_root_directory is not None and root != canonical_root_directory:
            raise ToolPackIntegrityError(
                "payload_path_case_invalid",
                "Tool Pack root directories must use exact portable casing.",
            )
        if not allowed_root_file and canonical_root_directory is None:
            raise ToolPackIntegrityError(
                "payload_root_entry_invalid",
                "Tool Pack payload contains an unsupported root entry.",
            )
    else:
        canonical_root_directory = _ALLOWED_ROOT_DIRECTORY_KEYS.get(root.casefold())
        if canonical_root_directory is None:
            raise ToolPackIntegrityError(
                "payload_root_entry_invalid",
                "Tool Pack payload contains an unsupported root directory.",
            )
        if root != canonical_root_directory:
            raise ToolPackIntegrityError(
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
        raise ToolPackIntegrityError(
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
            raise ToolPackIntegrityError(
                "payload_changed",
                "Tool Pack payload changed while it was being inspected.",
            )
        return os.fdopen(descriptor, "rb")
    except Exception:
        os.close(descriptor)
        raise


def _hash_regular_file(
    path: Path,
    path_stat: os.stat_result,
    max_single_file_bytes: int = MAX_SINGLE_FILE_BYTES,
) -> tuple[int, str]:
    if path_stat.st_size > max_single_file_bytes:
        raise ToolPackIntegrityError(
            "scan_limit_exceeded",
            "Tool Pack payload contains a file above the size limit.",
        )
    digest = hashlib.sha256()
    byte_count = 0
    try:
        with _open_regular_file(path, path_stat) as source:
            while True:
                chunk = source.read(STREAM_CHUNK_SIZE)
                if not chunk:
                    break
                byte_count += len(chunk)
                digest.update(chunk)
            final_stat = os.fstat(source.fileno())
    except ToolPackIntegrityError:
        raise
    except OSError as exc:
        raise ToolPackIntegrityError(
            "payload_file_unreadable",
            "A Tool Pack payload file could not be read.",
        ) from exc
    if (
        byte_count != path_stat.st_size
        or final_stat.st_size != path_stat.st_size
        or not _same_file_identity(path_stat, final_stat)
        or getattr(final_stat, "st_mtime_ns", None)
        != getattr(path_stat, "st_mtime_ns", None)
    ):
        raise ToolPackIntegrityError(
            "payload_changed",
            "Tool Pack payload changed while it was being inspected.",
        )
    return byte_count, "sha256:" + digest.hexdigest()


def snapshot_tool_pack_payload(
    plugin_directory_value: str | os.PathLike[str],
    *,
    max_files: int = MAX_PAYLOAD_FILES,
    max_tree_depth: int = MAX_PAYLOAD_TREE_DEPTH,
    max_scan_entries: int = MAX_PAYLOAD_SCAN_ENTRIES,
    max_single_file_bytes: int = MAX_SINGLE_FILE_BYTES,
    max_total_file_bytes: int = MAX_TOTAL_FILE_BYTES,
) -> tuple[ToolPackPayloadFile, ...]:
    plugin_directory = Path(plugin_directory_value)
    try:
        root_stat = plugin_directory.lstat()
    except OSError as exc:
        raise ToolPackIntegrityError(
            "plugin_directory_unreadable",
            "Plugin directory could not be inspected.",
        ) from exc
    if _is_reparse_stat(root_stat) or not stat.S_ISDIR(root_stat.st_mode):
        raise ToolPackIntegrityError(
            "plugin_directory_invalid",
            "Plugin directory must be a real directory, not a reparse point.",
        )

    pending: list[tuple[Path, str, int]] = [(plugin_directory, "", 0)]
    records: list[ToolPackPayloadFile] = []
    path_kinds: dict[str, tuple[str, str]] = {}
    total_bytes = 0
    scan_entries = 0
    reserved_key = _portable_path_key(DISTRIBUTION_RELATIVE_PATH.as_posix())
    while pending:
        directory, relative_directory, depth = pending.pop()
        try:
            with os.scandir(directory) as iterator:
                entries = []
                for entry in iterator:
                    scan_entries += 1
                    if scan_entries > max_scan_entries:
                        raise ToolPackIntegrityError(
                            "scan_limit_exceeded",
                            "Tool Pack payload exceeds the bounded scan limits.",
                        )
                    entries.append(entry)
            entries.sort(key=lambda item: item.name.encode("utf-8"))
        except ToolPackIntegrityError:
            raise
        except (OSError, UnicodeError) as exc:
            raise ToolPackIntegrityError(
                "plugin_directory_unreadable",
                "Plugin directory could not be enumerated safely.",
            ) from exc

        for entry in entries:
            relative_path = (
                f"{relative_directory}/{entry.name}"
                if relative_directory
                else entry.name
            )
            _validate_relative_path(relative_path)
            _validate_payload_path_policy(relative_path)
            try:
                entry_stat = entry.stat(follow_symlinks=False)
            except OSError as exc:
                raise ToolPackIntegrityError(
                    "payload_file_unreadable",
                    "A Tool Pack payload entry could not be inspected.",
                ) from exc
            if _is_reparse_stat(entry_stat):
                raise ToolPackIntegrityError(
                    "payload_reparse_point",
                    "Tool Pack payloads must not contain reparse points or symbolic links.",
                )
            if (
                "/" not in relative_path
                and relative_path in _ALLOWED_ROOT_DIRECTORIES
                and not stat.S_ISDIR(entry_stat.st_mode)
            ):
                raise ToolPackIntegrityError(
                    "payload_root_entry_invalid",
                    "A Tool Pack root directory name is occupied by a file.",
                )
            path_key = _portable_path_key(relative_path)
            entry_kind = "directory" if stat.S_ISDIR(entry_stat.st_mode) else "file"
            prior = path_kinds.get(path_key)
            if prior is not None and prior != (relative_path, entry_kind):
                raise ToolPackIntegrityError(
                    "payload_path_collision",
                    "Tool Pack payload paths collide on a portable filesystem.",
                )
            path_kinds[path_key] = (relative_path, entry_kind)
            if stat.S_ISDIR(entry_stat.st_mode):
                child_depth = depth + 1
                if child_depth > max_tree_depth:
                    raise ToolPackIntegrityError(
                        "scan_limit_exceeded",
                        "Tool Pack payload exceeds the bounded scan limits.",
                    )
                pending.append((Path(entry.path), relative_path, child_depth))
                continue
            if not stat.S_ISREG(entry_stat.st_mode):
                raise ToolPackIntegrityError(
                    "payload_special_file",
                    "Tool Pack payloads may contain only regular files and directories.",
                )
            if path_key == reserved_key:
                if relative_path != DISTRIBUTION_RELATIVE_PATH.as_posix():
                    raise ToolPackIntegrityError(
                        "payload_path_collision",
                        "Tool Pack payload conflicts with reserved distribution metadata.",
                    )
                continue
            if len(records) >= max_files:
                raise ToolPackIntegrityError(
                    "scan_limit_exceeded",
                    "Tool Pack payload exceeds the bounded file-count limit.",
                )
            byte_count, digest = _hash_regular_file(
                Path(entry.path),
                entry_stat,
                max_single_file_bytes,
            )
            total_bytes += byte_count
            if total_bytes > max_total_file_bytes:
                raise ToolPackIntegrityError(
                    "scan_limit_exceeded",
                    "Tool Pack payload exceeds the bounded total-size limit.",
                )
            records.append(
                ToolPackPayloadFile(
                    relative_path=relative_path,
                    absolute_path=Path(entry.path),
                    size=byte_count,
                    sha256=digest,
                    snapshot_stat=entry_stat,
                )
            )
    records.sort(key=lambda item: item.relative_path.encode("utf-8"))
    return tuple(records)


def payload_tree_sha256(
    records: Iterable[ToolPackPayloadFile | tuple[str, int, str]],
) -> str:
    digest = hashlib.sha256()
    for item in records:
        if isinstance(item, ToolPackPayloadFile):
            relative_path, size, sha256 = (
                item.relative_path,
                item.size,
                item.sha256,
            )
        else:
            relative_path, size, sha256 = item
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
        digest.update(sha256.encode("ascii"))
        digest.update(b"\n")
    return "sha256:" + digest.hexdigest()


def snapshot_bounded_directory(
    directory_value: str | os.PathLike[str],
) -> tuple[ToolPackPayloadFile, ...]:
    directory = Path(directory_value)
    try:
        root_stat = directory.lstat()
    except OSError as exc:
        raise ToolPackIntegrityError(
            "dependency_policy_invalid",
            "Vendored dependency directory could not be inspected.",
        ) from exc
    if _is_reparse_stat(root_stat) or not stat.S_ISDIR(root_stat.st_mode):
        raise ToolPackIntegrityError(
            "dependency_policy_invalid",
            "Vendored dependency root must be a real directory.",
        )

    pending: list[tuple[Path, str, int]] = [(directory, "", 0)]
    records: list[ToolPackPayloadFile] = []
    keys: set[str] = set()
    scan_entries = 0
    total_bytes = 0
    while pending:
        current, relative_directory, depth = pending.pop()
        try:
            with os.scandir(current) as iterator:
                entries = []
                for entry in iterator:
                    scan_entries += 1
                    if scan_entries > MAX_PAYLOAD_SCAN_ENTRIES:
                        raise ToolPackIntegrityError(
                            "scan_limit_exceeded",
                            "Vendored dependency tree exceeds the bounded scan limits.",
                        )
                    entries.append(entry)
            entries.sort(key=lambda item: item.name.encode("utf-8"))
        except ToolPackIntegrityError:
            raise
        except (OSError, UnicodeError) as exc:
            raise ToolPackIntegrityError(
                "dependency_policy_invalid",
                "Vendored dependency directory could not be enumerated safely.",
            ) from exc
        for entry in entries:
            relative_path = (
                f"{relative_directory}/{entry.name}"
                if relative_directory
                else entry.name
            )
            _validate_relative_path(relative_path)
            try:
                entry_stat = entry.stat(follow_symlinks=False)
            except OSError as exc:
                raise ToolPackIntegrityError(
                    "dependency_policy_invalid",
                    "Vendored dependency entry could not be inspected.",
                ) from exc
            if _is_reparse_stat(entry_stat):
                raise ToolPackIntegrityError(
                    "payload_reparse_point",
                    "Vendored dependencies must not contain reparse points or symbolic links.",
                )
            key = _portable_path_key(relative_path)
            if key in keys:
                raise ToolPackIntegrityError(
                    "payload_path_collision",
                    "Vendored dependency paths collide on a portable filesystem.",
                )
            keys.add(key)
            if stat.S_ISDIR(entry_stat.st_mode):
                if depth + 1 > MAX_PAYLOAD_TREE_DEPTH:
                    raise ToolPackIntegrityError(
                        "scan_limit_exceeded",
                        "Vendored dependency tree exceeds the bounded scan limits.",
                    )
                pending.append((Path(entry.path), relative_path, depth + 1))
                continue
            if not stat.S_ISREG(entry_stat.st_mode):
                raise ToolPackIntegrityError(
                    "payload_special_file",
                    "Vendored dependencies may contain only regular files and directories.",
                )
            if entry.name.casefold().endswith((".pyc", ".pyo", ".pyd", ".so", ".dylib")):
                raise ToolPackIntegrityError(
                    "in_process_native_dependency_unsupported",
                    "Vendored dependencies must contain pure Python source only.",
                )
            if len(records) >= MAX_PAYLOAD_FILES:
                raise ToolPackIntegrityError(
                    "scan_limit_exceeded",
                    "Vendored dependency tree exceeds the bounded file-count limit.",
                )
            byte_count, digest = _hash_regular_file(Path(entry.path), entry_stat)
            total_bytes += byte_count
            if total_bytes > MAX_TOTAL_FILE_BYTES:
                raise ToolPackIntegrityError(
                    "scan_limit_exceeded",
                    "Vendored dependency tree exceeds the bounded total-size limit.",
                )
            records.append(
                ToolPackPayloadFile(
                    relative_path=relative_path,
                    absolute_path=Path(entry.path),
                    size=byte_count,
                    sha256=digest,
                    snapshot_stat=entry_stat,
                )
            )
    records.sort(key=lambda item: item.relative_path.encode("utf-8"))
    return tuple(records)


def compute_bounded_directory_sha256(
    directory: str | os.PathLike[str],
) -> str:
    return payload_tree_sha256(snapshot_bounded_directory(directory))


def compute_tool_pack_payload_sha256(
    plugin_directory: str | os.PathLike[str],
) -> str:
    return payload_tree_sha256(snapshot_tool_pack_payload(plugin_directory))


__all__ = [
    "DISTRIBUTION_RELATIVE_PATH",
    "MAX_POLICY_PACKS",
    "MAX_CORE_API_VERSION",
    "POLICY_FORMAT",
    "POLICY_RELATIVE_PATH",
    "POLICY_SCHEMA_VERSION",
    "ToolPackIntegrityError",
    "ToolPackPayloadFile",
    "ToolPackPolicy",
    "ToolPackPolicyEntry",
    "compute_bounded_directory_sha256",
    "compute_tool_pack_payload_sha256",
    "load_project_tool_pack_policy",
    "payload_tree_sha256",
    "read_tool_pack_policy",
    "snapshot_tool_pack_payload",
    "snapshot_bounded_directory",
]
