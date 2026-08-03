#!/usr/bin/env python3
"""Safely extract a digest-verified GitHub Actions artifact ZIP.

The caller is responsible for verifying the archive digest before invoking this
tool.  This extractor treats every ZIP field as untrusted: it validates the
complete central-directory view before creating a staging directory, streams
each member with independent byte accounting, and publishes the result with an
atomic no-replace rename.
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import os
import re
import shutil
import stat
import struct
import sys
import tempfile
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Dict, Iterable, List, Optional, Sequence, Tuple


KIB = 1024
MIB = 1024 * KIB
GIB = 1024 * MIB
STREAM_CHUNK_SIZE = MIB
MAX_MEMBER_NAME_BYTES = 4096
MAX_COMPONENT_BYTES = 255


class ExtractionError(RuntimeError):
    """Raised when an artifact is unsafe or violates its extraction profile."""


@dataclass(frozen=True)
class ProfileLimits:
    max_entries: int
    max_archive_size: int
    max_total_compressed: int
    max_entry_uncompressed: int
    max_total_uncompressed: int
    max_compression_ratio: int
    required_root_file: Optional[str] = None
    require_nonempty_root_file: bool = False


# The package profile deliberately leaves ample room above the current roughly
# 15 MiB artifact and for a large UE PDB, while retaining finite resource caps.
PROFILE_LIMITS: Dict[str, ProfileLimits] = {
    "package": ProfileLimits(
        max_entries=20_000,
        max_archive_size=128 * MIB,
        max_total_compressed=120 * MIB,
        max_entry_uncompressed=GIB,
        max_total_uncompressed=2 * GIB,
        max_compression_ratio=200,
    ),
    "build-environment": ProfileLimits(
        max_entries=1,
        max_archive_size=256 * KIB,
        max_total_compressed=128 * KIB,
        max_entry_uncompressed=64 * KIB,
        max_total_uncompressed=64 * KIB,
        max_compression_ratio=100,
        required_root_file="BuildEnvironment.json",
        require_nonempty_root_file=True,
    ),
}


_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")
_WINDOWS_FORBIDDEN = frozenset('<>:"|?*')
_WINDOWS_RESERVED = re.compile(r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$", re.I)
_SUPPORTED_COMPRESSION = frozenset((zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED))
_ENCRYPTION_FLAGS = (1 << 0) | (1 << 6) | (1 << 13)
_UNSUPPORTED_DOS_ATTRIBUTES = 0x0008 | 0x0040 | 0x0400 | 0x4000
_LOCAL_FILE_HEADER = struct.Struct("<IHHHHHIIIHH")
_LOCAL_FILE_HEADER_SIGNATURE = 0x04034B50


@dataclass(frozen=True)
class PreparedEntry:
    info: zipfile.ZipInfo
    parts: Tuple[str, ...]
    is_directory: bool
    permissions: int


class _PathTrieNode:
    def __init__(self) -> None:
        self.children: Dict[str, "_PathTrieNode"] = {}
        self.entry_kind: Optional[str] = None


def _format_limit(value: int) -> str:
    if value % GIB == 0:
        return f"{value // GIB} GiB"
    if value % MIB == 0:
        return f"{value // MIB} MiB"
    if value % KIB == 0:
        return f"{value // KIB} KiB"
    return f"{value} bytes"


def _open_regular_archive(path: Path, limits: ProfileLimits) -> Tuple[BinaryIO, os.stat_result]:
    try:
        path_stat = os.lstat(str(path))
    except OSError as error:
        raise ExtractionError(f"Cannot inspect archive '{path}': {error}") from error

    if not stat.S_ISREG(path_stat.st_mode):
        raise ExtractionError("Archive must be a regular file (not a directory, link, or device).")
    if path_stat.st_size <= 0:
        raise ExtractionError("Archive must be non-empty.")
    if path_stat.st_size > limits.max_archive_size:
        raise ExtractionError(
            f"Archive is larger than the {_format_limit(limits.max_archive_size)} profile limit."
        )

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(str(path), flags)
    except OSError as error:
        raise ExtractionError(f"Cannot open archive '{path}' safely: {error}") from error

    try:
        opened_stat = os.fstat(descriptor)
        if not stat.S_ISREG(opened_stat.st_mode):
            raise ExtractionError("Opened archive is not a regular file.")
        if opened_stat.st_size != path_stat.st_size:
            raise ExtractionError("Archive changed while it was being opened.")
        if (
            getattr(path_stat, "st_ino", 0)
            and getattr(opened_stat, "st_ino", 0)
            and (path_stat.st_dev, path_stat.st_ino) != (opened_stat.st_dev, opened_stat.st_ino)
        ):
            raise ExtractionError("Archive path was replaced while it was being opened.")
        return os.fdopen(descriptor, "rb"), opened_stat
    except Exception:
        os.close(descriptor)
        raise


def _validate_component(component: str, member_name: str) -> None:
    if component in ("", ".", ".."):
        raise ExtractionError(f"Archive member has an empty, dot, or parent component: {member_name!r}")
    try:
        encoded = component.encode("utf-8", "strict")
    except UnicodeError as error:
        raise ExtractionError(f"Archive member is not valid Unicode: {member_name!r}") from error
    if len(encoded) > MAX_COMPONENT_BYTES:
        raise ExtractionError(f"Archive member component is too long: {member_name!r}")
    if any(ord(character) < 32 for character in component):
        raise ExtractionError(f"Archive member contains a control character: {member_name!r}")
    if any(character in _WINDOWS_FORBIDDEN for character in component):
        raise ExtractionError(f"Archive member is not a portable filesystem path: {member_name!r}")
    if component.endswith((" ", ".")) or _WINDOWS_RESERVED.fullmatch(component):
        raise ExtractionError(f"Archive member is not a portable filesystem path: {member_name!r}")


def _validated_member_parts(info: zipfile.ZipInfo) -> Tuple[Tuple[str, ...], bool]:
    original_name = getattr(info, "orig_filename", info.filename)
    if not isinstance(original_name, str) or not original_name:
        raise ExtractionError("Archive contains an empty member name.")
    if "\x00" in original_name:
        raise ExtractionError("Archive member name contains a NUL byte.")
    if "\\" in original_name:
        raise ExtractionError(f"Archive member uses a backslash separator: {original_name!r}")
    if original_name != info.filename:
        raise ExtractionError("Archive member name was altered while parsing the ZIP metadata.")
    if original_name.startswith("/") or _DRIVE_PREFIX.match(original_name):
        raise ExtractionError(f"Archive member uses an absolute or drive path: {original_name!r}")

    try:
        encoded_name = original_name.encode("utf-8", "strict")
    except UnicodeError as error:
        raise ExtractionError(f"Archive member is not valid Unicode: {original_name!r}") from error
    if len(encoded_name) > MAX_MEMBER_NAME_BYTES:
        raise ExtractionError(f"Archive member name is too long: {original_name!r}")

    is_directory = original_name.endswith("/")
    path_text = original_name[:-1] if is_directory else original_name
    if not path_text:
        raise ExtractionError("Archive contains an empty or root-only member name.")
    parts = tuple(path_text.split("/"))
    for component in parts:
        _validate_component(component, original_name)
    return parts, is_directory


def _validated_permissions(info: zipfile.ZipInfo, is_directory: bool) -> int:
    if info.create_system == 3:  # UNIX
        mode = (info.external_attr >> 16) & 0xFFFF
        file_type = stat.S_IFMT(mode)
        if mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX):
            raise ExtractionError(f"Archive member has unsupported special permissions: {info.filename!r}")
        expected_type = stat.S_IFDIR if is_directory else stat.S_IFREG
        if file_type not in (0, expected_type):
            if file_type == stat.S_IFLNK:
                detail = "symbolic link"
            else:
                detail = "special or unsupported file type"
            raise ExtractionError(f"Archive member is a {detail}: {info.filename!r}")
        if mode == 0:
            return 0o755 if is_directory else 0o644
        return mode & 0o777

    if info.create_system not in (0, 10):  # FAT/MS-DOS or NTFS
        raise ExtractionError(
            f"Archive member uses unsupported creator/mode metadata: {info.filename!r}"
        )
    dos_attributes = info.external_attr & 0xFFFF
    if dos_attributes & _UNSUPPORTED_DOS_ATTRIBUTES:
        raise ExtractionError(f"Archive member has unsupported special attributes: {info.filename!r}")
    if not is_directory and dos_attributes & 0x0010:
        raise ExtractionError(f"Archive file is marked as a directory: {info.filename!r}")
    return 0o755 if is_directory else 0o644


def _canonical_parts(parts: Iterable[str]) -> Tuple[str, ...]:
    return tuple(
        unicodedata.normalize("NFC", unicodedata.normalize("NFC", part).casefold())
        for part in parts
    )


def _register_path(root: _PathTrieNode, parts: Tuple[str, ...], is_directory: bool) -> None:
    node = root
    for component in _canonical_parts(parts):
        if node.entry_kind == "file":
            raise ExtractionError("Archive has a file/directory prefix conflict.")
        node = node.children.setdefault(component, _PathTrieNode())

    if node.entry_kind is not None:
        raise ExtractionError("Archive has duplicate paths after case and Unicode normalization.")
    if not is_directory and node.children:
        raise ExtractionError("Archive has a file/directory prefix conflict.")
    node.entry_kind = "directory" if is_directory else "file"


def _check_ratio(uncompressed: int, compressed: int, maximum: int, member: str) -> None:
    if uncompressed == 0:
        return
    if compressed == 0 or uncompressed > compressed * maximum:
        raise ExtractionError(
            f"Archive compression ratio exceeds {maximum}:1 for {member!r}."
        )


def _validate_local_header(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> None:
    if archive.fp is None:
        raise ExtractionError("Archive closed unexpectedly during local-header preflight.")
    try:
        original_position = archive.fp.tell()
        archive.fp.seek(info.header_offset)
        fixed_header = archive.fp.read(_LOCAL_FILE_HEADER.size)
        if len(fixed_header) != _LOCAL_FILE_HEADER.size:
            raise ExtractionError(f"Archive member has a truncated local header: {info.filename!r}")
        (
            signature,
            _version_needed,
            local_flags,
            local_compression,
            _modified_time,
            _modified_date,
            _crc,
            _compressed_size,
            _uncompressed_size,
            local_name_length,
            _local_extra_length,
        ) = _LOCAL_FILE_HEADER.unpack(fixed_header)
        if signature != _LOCAL_FILE_HEADER_SIGNATURE:
            raise ExtractionError(f"Archive member has an invalid local header: {info.filename!r}")
        local_name = archive.fp.read(local_name_length)
        if len(local_name) != local_name_length:
            raise ExtractionError(f"Archive member has a truncated local filename: {info.filename!r}")
    except OSError as error:
        raise ExtractionError(f"Cannot inspect local ZIP metadata for {info.filename!r}: {error}") from error
    finally:
        try:
            archive.fp.seek(original_position)
        except (OSError, UnboundLocalError):
            pass

    if local_flags & _ENCRYPTION_FLAGS:
        raise ExtractionError(f"Encrypted local archive member is not supported: {info.filename!r}")
    if local_flags != info.flag_bits:
        raise ExtractionError(f"Archive member local and central flags differ: {info.filename!r}")
    if local_compression not in _SUPPORTED_COMPRESSION or local_compression != info.compress_type:
        raise ExtractionError(
            f"Archive member local compression is unsupported or inconsistent: {info.filename!r}"
        )
    encoding = "utf-8" if info.flag_bits & 0x0800 else "cp437"
    try:
        expected_name = info.orig_filename.encode(encoding, "strict")
    except UnicodeError as error:
        raise ExtractionError(f"Archive member filename encoding is inconsistent: {info.filename!r}") from error
    if local_name != expected_name:
        raise ExtractionError(f"Archive member local and central filenames differ: {info.filename!r}")


def _preflight(archive: zipfile.ZipFile, limits: ProfileLimits) -> Tuple[List[PreparedEntry], int]:
    infos = archive.infolist()
    if not infos:
        raise ExtractionError("Archive contains no members.")
    if len(infos) > limits.max_entries:
        raise ExtractionError(f"Archive contains more than {limits.max_entries} members.")

    prepared: List[PreparedEntry] = []
    trie = _PathTrieNode()
    total_compressed = 0
    total_uncompressed = 0

    for info in infos:
        if info.flag_bits & _ENCRYPTION_FLAGS:
            raise ExtractionError(f"Encrypted archive members are not supported: {info.filename!r}")
        if info.compress_type not in _SUPPORTED_COMPRESSION:
            raise ExtractionError(f"Archive member uses unsupported compression: {info.filename!r}")
        if info.compress_size < 0 or info.file_size < 0:
            raise ExtractionError(f"Archive member has an invalid size: {info.filename!r}")

        parts, is_directory = _validated_member_parts(info)
        permissions = _validated_permissions(info, is_directory)
        if is_directory and info.file_size != 0:
            raise ExtractionError(f"Archive directory contains data: {info.filename!r}")
        if info.file_size > limits.max_entry_uncompressed:
            raise ExtractionError(
                f"Archive member exceeds the {_format_limit(limits.max_entry_uncompressed)} "
                f"per-entry limit: {info.filename!r}"
            )

        total_compressed += info.compress_size
        total_uncompressed += info.file_size
        if total_compressed > limits.max_total_compressed:
            raise ExtractionError(
                "Archive members exceed the "
                f"{_format_limit(limits.max_total_compressed)} compressed-data limit."
            )
        if total_uncompressed > limits.max_total_uncompressed:
            raise ExtractionError(
                "Archive members exceed the "
                f"{_format_limit(limits.max_total_uncompressed)} total-uncompressed limit."
            )
        _check_ratio(info.file_size, info.compress_size, limits.max_compression_ratio, info.filename)
        _register_path(trie, parts, is_directory)
        prepared.append(PreparedEntry(info, parts, is_directory, permissions))

    _check_ratio(
        total_uncompressed,
        total_compressed,
        limits.max_compression_ratio,
        "the complete archive",
    )

    if limits.required_root_file is not None:
        if len(prepared) != 1:
            raise ExtractionError(
                f"This profile requires only root {limits.required_root_file}."
            )
        only_entry = prepared[0]
        if only_entry.is_directory or only_entry.info.filename != limits.required_root_file:
            raise ExtractionError(
                f"This profile requires one regular root {limits.required_root_file}."
            )
        if limits.require_nonempty_root_file and only_entry.info.file_size == 0:
            raise ExtractionError(f"{limits.required_root_file} must be non-empty.")

    # ZipFile.open validates each corresponding local header, including its raw
    # filename, encryption bit, and overlap boundary.  Opening without reading
    # performs those checks only after the whole central-directory view has
    # passed resource and shape validation, and still before staging exists.
    for entry in prepared:
        _validate_local_header(archive, entry.info)
        try:
            with archive.open(entry.info, "r"):
                pass
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
            raise ExtractionError(
                f"Archive member has invalid or unsupported local metadata: {entry.info.filename!r}"
            ) from error

    return prepared, total_uncompressed


def _ensure_directory(root: Path, parts: Sequence[str]) -> Path:
    current = root
    for component in parts:
        current = current / component
        try:
            os.mkdir(str(current), 0o700)
        except FileExistsError:
            try:
                current_stat = os.lstat(str(current))
            except OSError as error:
                raise ExtractionError(f"Cannot inspect staging path '{current}': {error}") from error
            if not stat.S_ISDIR(current_stat.st_mode):
                raise ExtractionError(f"Staging path is not a directory: {current}")
    return current


def _stream_file(
    archive: zipfile.ZipFile,
    entry: PreparedEntry,
    output_path: Path,
    limits: ProfileLimits,
    total_written: int,
) -> int:
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        descriptor = os.open(str(output_path), flags, 0o600)
    except OSError as error:
        raise ExtractionError(f"Cannot create staged file '{output_path}': {error}") from error

    entry_written = 0
    try:
        with os.fdopen(descriptor, "wb") as destination_file:
            with archive.open(entry.info, "r") as source_file:
                while True:
                    chunk = source_file.read(STREAM_CHUNK_SIZE)
                    if not chunk:
                        break
                    entry_written += len(chunk)
                    total_written += len(chunk)
                    if entry_written > entry.info.file_size:
                        raise ExtractionError(
                            f"Archive member expanded beyond its declared size: {entry.info.filename!r}"
                        )
                    if entry_written > limits.max_entry_uncompressed:
                        raise ExtractionError(
                            f"Archive member exceeded its streaming size limit: {entry.info.filename!r}"
                        )
                    if total_written > limits.max_total_uncompressed:
                        raise ExtractionError("Archive exceeded its streaming total-uncompressed limit.")
                    destination_file.write(chunk)
            destination_file.flush()
            os.fsync(destination_file.fileno())
    except Exception:
        try:
            os.unlink(str(output_path))
        except OSError:
            pass
        raise

    if entry_written != entry.info.file_size:
        raise ExtractionError(
            f"Archive member size changed while streaming: {entry.info.filename!r}"
        )
    os.chmod(str(output_path), entry.permissions)
    return total_written


def _validate_empty_directory_stream(archive: zipfile.ZipFile, entry: PreparedEntry) -> None:
    with archive.open(entry.info, "r") as source_file:
        if source_file.read(1):
            raise ExtractionError(f"Archive directory unexpectedly expanded data: {entry.info.filename!r}")


def _extract_to_staging(
    archive: zipfile.ZipFile,
    entries: Sequence[PreparedEntry],
    expected_total: int,
    limits: ProfileLimits,
    staging: Path,
) -> None:
    total_written = 0
    explicit_directories: List[Tuple[Path, int]] = []

    for entry in entries:
        if entry.is_directory:
            _validate_empty_directory_stream(archive, entry)
            directory_path = _ensure_directory(staging, entry.parts)
            explicit_directories.append((directory_path, entry.permissions))
            continue

        parent = _ensure_directory(staging, entry.parts[:-1])
        output_path = parent / entry.parts[-1]
        total_written = _stream_file(
            archive,
            entry,
            output_path,
            limits,
            total_written,
        )

    if total_written != expected_total:
        raise ExtractionError("Archive streaming byte count did not match the preflight total.")

    for directory_path, permissions in sorted(
        explicit_directories, key=lambda value: len(value[0].parts), reverse=True
    ):
        os.chmod(str(directory_path), permissions)


def _atomic_rename_no_replace(source: Path, destination: Path) -> None:
    """Atomically rename a directory while refusing to replace any destination."""

    if os.name == "nt":
        # MoveFileEx without MOVEFILE_REPLACE_EXISTING, as used by os.rename on
        # Windows, is an atomic no-replace operation on the same volume.
        os.rename(str(source), str(destination))
        return

    if sys.platform.startswith("linux"):
        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = getattr(libc, "renameat2", None)
        if renameat2 is None:
            raise ExtractionError("This Linux runtime does not provide atomic no-replace renameat2.")
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        result = renameat2(
            -100,  # AT_FDCWD
            os.fsencode(str(source)),
            -100,
            os.fsencode(str(destination)),
            1,  # RENAME_NOREPLACE
        )
        if result == 0:
            return
        error_number = ctypes.get_errno()
        if error_number == errno.EEXIST:
            raise FileExistsError(error_number, os.strerror(error_number), str(destination))
        raise OSError(error_number, os.strerror(error_number), str(destination))

    if sys.platform == "darwin":
        libc = ctypes.CDLL(None, use_errno=True)
        renamex_np = getattr(libc, "renamex_np", None)
        if renamex_np is None:
            raise ExtractionError("This macOS runtime does not provide atomic no-replace renamex_np.")
        renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex_np.restype = ctypes.c_int
        if renamex_np(os.fsencode(str(source)), os.fsencode(str(destination)), 0x00000004) == 0:
            return
        error_number = ctypes.get_errno()
        if error_number == errno.EEXIST:
            raise FileExistsError(error_number, os.strerror(error_number), str(destination))
        raise OSError(error_number, os.strerror(error_number), str(destination))

    raise ExtractionError("This platform does not provide a supported atomic no-replace rename.")


def _cleanup_staging(staging: Path) -> None:
    """Remove only the private staging tree, surfacing any cleanup failure."""

    try:
        staging_stat = os.lstat(str(staging))
    except FileNotFoundError:
        return
    except OSError as error:
        raise ExtractionError(f"Cannot inspect staging directory during cleanup: {error}") from error
    if not stat.S_ISDIR(staging_stat.st_mode):
        raise ExtractionError("Private staging path changed type before cleanup; refusing to follow it.")

    def make_writable_and_retry(function, path, _error_info):
        os.chmod(path, stat.S_IRWXU)
        function(path)

    try:
        os.chmod(str(staging), stat.S_IRWXU)
        if sys.version_info >= (3, 12):
            shutil.rmtree(str(staging), onexc=make_writable_and_retry)
        else:
            shutil.rmtree(str(staging), onerror=make_writable_and_retry)
    except OSError as error:
        raise ExtractionError(f"Failed to remove private staging directory '{staging}': {error}") from error
    if os.path.lexists(str(staging)):
        raise ExtractionError(f"Private staging directory still exists after cleanup: {staging}")


def _resolved_destination(path: Path) -> Path:
    if path.name in ("", ".", ".."):
        raise ExtractionError("Destination must name a new directory.")
    try:
        parent = path.parent.resolve(strict=True)
        parent_stat = os.stat(str(parent))
    except OSError as error:
        raise ExtractionError(f"Destination parent is unavailable: {error}") from error
    if not stat.S_ISDIR(parent_stat.st_mode):
        raise ExtractionError("Destination parent must be a directory.")
    return parent / path.name


def extract_verified_artifact(archive_path: Path, destination_path: Path, profile: str) -> Path:
    try:
        limits = PROFILE_LIMITS[profile]
    except KeyError as error:
        raise ExtractionError(f"Unknown extraction profile: {profile!r}") from error

    destination = _resolved_destination(destination_path)
    if os.path.lexists(str(destination)):
        raise ExtractionError(f"Destination already exists: {destination}")

    archive_file, opened_stat = _open_regular_archive(archive_path, limits)
    staging: Optional[Path] = None
    try:
        with archive_file:
            try:
                with zipfile.ZipFile(archive_file, "r") as archive:
                    entries, expected_total = _preflight(archive, limits)
                    # No output path, including staging, is created before every
                    # central-directory entry has passed preflight.
                    staging = Path(
                        tempfile.mkdtemp(
                            prefix=f".{destination.name}.extract-",
                            dir=str(destination.parent),
                        )
                    )
                    os.chmod(str(staging), 0o700)
                    _extract_to_staging(archive, entries, expected_total, limits, staging)
            except zipfile.BadZipFile as error:
                raise ExtractionError(f"Archive is not a valid ZIP: {error}") from error

            final_stat = os.fstat(archive_file.fileno())
            if final_stat.st_size != opened_stat.st_size:
                raise ExtractionError("Archive size changed during extraction.")

        try:
            _atomic_rename_no_replace(staging, destination)
        except FileExistsError as error:
            raise ExtractionError(f"Destination appeared during extraction: {destination}") from error
        staging = None
        return destination
    finally:
        if staging is not None and os.path.lexists(str(staging)):
            _cleanup_staging(staging)


def _parse_arguments(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Safely extract an already digest-verified GitHub artifact ZIP."
    )
    parser.add_argument("--archive", required=True, type=Path, help="Verified artifact ZIP path")
    parser.add_argument("--destination", required=True, type=Path, help="New destination directory")
    parser.add_argument(
        "--profile",
        required=True,
        choices=tuple(PROFILE_LIMITS),
        help="Artifact structure and resource-limit profile",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    arguments = _parse_arguments(argv)
    try:
        destination = extract_verified_artifact(
            arguments.archive,
            arguments.destination,
            arguments.profile,
        )
    except (ExtractionError, OSError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"Extracted verified {arguments.profile} artifact to {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
