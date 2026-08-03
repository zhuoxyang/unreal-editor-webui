import importlib.util
import os
import pathlib
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest import mock


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
EXTRACTOR_PATH = REPO_ROOT / "scripts" / "extract-verified-artifact.py"


def load_extractor():
    spec = importlib.util.spec_from_file_location("extract_verified_artifact", EXTRACTOR_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


EXTRACTOR = load_extractor()


def run_extractor(archive, destination, profile="package"):
    environment = os.environ.copy()
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        [
            sys.executable,
            str(EXTRACTOR_PATH),
            "--archive",
            str(archive),
            "--destination",
            str(destination),
            "--profile",
            profile,
        ],
        cwd=str(REPO_ROOT),
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )


def write_zip(path, entries, compression=zipfile.ZIP_STORED):
    with zipfile.ZipFile(path, "w", compression=compression, allowZip64=True) as archive:
        for name, data in entries:
            archive.writestr(name, data)


def write_mode_zip(path, name, mode, data=b"x", creator=3):
    info = zipfile.ZipInfo(name)
    info.create_system = creator
    info.compress_type = zipfile.ZIP_STORED
    info.external_attr = (mode & 0xFFFF) << 16
    with zipfile.ZipFile(path, "w", allowZip64=True) as archive:
        archive.writestr(info, data)


def central_records(data):
    eocd = data.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise AssertionError("test ZIP has no EOCD")
    count = struct.unpack_from("<H", data, eocd + 10)[0]
    offset = struct.unpack_from("<I", data, eocd + 16)[0]
    records = []
    for _ in range(count):
        if data[offset : offset + 4] != b"PK\x01\x02":
            raise AssertionError("test ZIP has an unexpected central-directory record")
        name_length, extra_length, comment_length = struct.unpack_from("<HHH", data, offset + 28)
        records.append((offset, offset + 46, name_length))
        offset += 46 + name_length + extra_length + comment_length
    return records


def patch_central_u32(path, entry_index, field_offset, value):
    data = bytearray(path.read_bytes())
    record, _, _ = central_records(data)[entry_index]
    struct.pack_into("<I", data, record + field_offset, value)
    path.write_bytes(data)


def patch_all_central_sizes(path, compressed_sizes, uncompressed_sizes):
    data = bytearray(path.read_bytes())
    records = central_records(data)
    if len(records) != len(compressed_sizes) or len(records) != len(uncompressed_sizes):
        raise AssertionError("test patch size list does not match member count")
    for (record, _, _), compressed, uncompressed in zip(
        records, compressed_sizes, uncompressed_sizes
    ):
        struct.pack_into("<I", data, record + 20, compressed)
        struct.pack_into("<I", data, record + 24, uncompressed)
    path.write_bytes(data)


def patch_member_name(path, replacement):
    data = bytearray(path.read_bytes())
    record, central_name_offset, name_length = central_records(data)[0]
    if len(replacement) != name_length:
        raise AssertionError("replacement member name must retain the encoded length")
    local_offset = struct.unpack_from("<I", data, record + 42)[0]
    local_name_length, local_extra_length = struct.unpack_from("<HH", data, local_offset + 26)
    if local_name_length != name_length:
        raise AssertionError("test ZIP local and central names differ in length")
    data[central_name_offset : central_name_offset + name_length] = replacement
    local_name_offset = local_offset + 30
    data[local_name_offset : local_name_offset + name_length] = replacement
    path.write_bytes(data)


def patch_encrypted_flag(path):
    data = bytearray(path.read_bytes())
    record, _, _ = central_records(data)[0]
    local_offset = struct.unpack_from("<I", data, record + 42)[0]
    central_flags = struct.unpack_from("<H", data, record + 8)[0]
    local_flags = struct.unpack_from("<H", data, local_offset + 6)[0]
    struct.pack_into("<H", data, record + 8, central_flags | 1)
    struct.pack_into("<H", data, local_offset + 6, local_flags | 1)
    path.write_bytes(data)


def patch_local_encrypted_flag(path, entry_index=0):
    data = bytearray(path.read_bytes())
    record, _, _ = central_records(data)[entry_index]
    local_offset = struct.unpack_from("<I", data, record + 42)[0]
    local_flags = struct.unpack_from("<H", data, local_offset + 6)[0]
    struct.pack_into("<H", data, local_offset + 6, local_flags | 1)
    path.write_bytes(data)


def corrupt_first_member_payload(path):
    data = bytearray(path.read_bytes())
    record, _, _ = central_records(data)[0]
    local_offset = struct.unpack_from("<I", data, record + 42)[0]
    name_length, extra_length = struct.unpack_from("<HH", data, local_offset + 26)
    payload_offset = local_offset + 30 + name_length + extra_length
    data[payload_offset] ^= 0xFF
    path.write_bytes(data)


class ExtractVerifiedArtifactTests(unittest.TestCase):
    def assert_no_staging(self, parent, destination_name):
        self.assertEqual(
            [],
            list(pathlib.Path(parent).glob(f".{destination_name}.extract-*")),
            "extractor left a private staging directory behind",
        )

    def test_package_profile_accepts_stored_and_deflated_files_and_a_15_mib_pdb(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "package.zip"
            destination = root / "trusted-package"
            pdb_size = 15 * EXTRACTOR.MIB + 4096
            pdb_payload = (b"PDB-test-block-" * ((pdb_size // 15) + 1))[:pdb_size]

            with zipfile.ZipFile(archive_path, "w", allowZip64=True) as archive:
                archive.writestr("UnrealEditorWebUI/", b"", compress_type=zipfile.ZIP_STORED)
                archive.writestr(
                    "UnrealEditorWebUI/README.md",
                    b"verified package\n",
                    compress_type=zipfile.ZIP_DEFLATED,
                )
                archive.writestr(
                    "UnrealEditorWebUI/Binaries/Win64/UnrealEditorWebUI.pdb",
                    pdb_payload,
                    compress_type=zipfile.ZIP_STORED,
                )
                executable = zipfile.ZipInfo("UnrealEditorWebUI/Tools/verify.sh")
                executable.create_system = 3
                executable.compress_type = zipfile.ZIP_DEFLATED
                executable.external_attr = (stat.S_IFREG | 0o755) << 16
                archive.writestr(executable, b"#!/bin/sh\nexit 0\n")

            self.assertGreater(archive_path.stat().st_size, 15 * EXTRACTOR.MIB)
            result = run_extractor(archive_path, destination)

            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual(
                b"verified package\n",
                (destination / "UnrealEditorWebUI" / "README.md").read_bytes(),
            )
            extracted_pdb = (
                destination
                / "UnrealEditorWebUI"
                / "Binaries"
                / "Win64"
                / "UnrealEditorWebUI.pdb"
            )
            self.assertEqual(pdb_size, extracted_pdb.stat().st_size)
            self.assertEqual(pdb_payload[:64], extracted_pdb.read_bytes()[:64])
            if os.name != "nt":
                self.assertEqual(
                    0o755,
                    stat.S_IMODE(
                        (destination / "UnrealEditorWebUI" / "Tools" / "verify.sh").stat().st_mode
                    ),
                )
            self.assert_no_staging(root, destination.name)
            if os.name != "nt":
                self.assertEqual(0o700, stat.S_IMODE(destination.stat().st_mode))

    def test_build_environment_profile_accepts_only_the_root_regular_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "environment.zip"
            destination = root / "trusted-environment"
            document = b'{"schemaVersion":2,"subject":{"artifactId":"42"}}\n'
            write_zip(
                archive_path,
                [("BuildEnvironment.json", document)],
                compression=zipfile.ZIP_DEFLATED,
            )

            result = run_extractor(archive_path, destination, "build-environment")

            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual(document, (destination / "BuildEnvironment.json").read_bytes())
            self.assertEqual(
                [pathlib.Path("BuildEnvironment.json")],
                [path.relative_to(destination) for path in destination.iterdir()],
            )
            self.assert_no_staging(root, destination.name)

    def test_all_member_metadata_is_preflighted_before_staging_is_created(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "invalid-second-entry.zip"
            destination = root / "output"
            write_zip(
                archive_path,
                [("safe.txt", b"safe"), ("../escape.txt", b"unsafe")],
            )

            result = run_extractor(archive_path, destination)

            self.assertNotEqual(0, result.returncode)
            self.assertFalse(destination.exists())
            self.assertFalse((root / "safe.txt").exists())
            self.assertFalse((root.parent / "escape.txt").exists())
            self.assert_no_staging(root, destination.name)

    def test_rejects_absolute_drive_dot_parent_empty_backslash_and_root_paths(self):
        invalid_names = (
            "/absolute.txt",
            "C:/drive.txt",
            "../parent.txt",
            "dir/../parent.txt",
            "./dot.txt",
            "dir/./dot.txt",
            "dir//empty.txt",
            "/",
        )
        for invalid_name in invalid_names:
            with self.subTest(name=invalid_name), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                archive_path = root / "invalid.zip"
                destination = root / "output"
                write_zip(archive_path, [(invalid_name, b"x")])

                result = run_extractor(archive_path, destination)

                self.assertNotEqual(0, result.returncode)
                self.assertFalse(os.path.lexists(destination))
                self.assert_no_staging(root, destination.name)

    def test_rejects_raw_backslash_before_zipinfo_path_rewriting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "backslash.zip"
            destination = root / "output"
            write_zip(archive_path, [("dir/slash.txt", b"x")])
            patch_member_name(archive_path, b"dir\\slash.txt")

            with zipfile.ZipFile(archive_path) as archive:
                info = archive.infolist()[0]
                self.assertIn("\\", info.orig_filename)
                if os.sep == "\\":
                    self.assertNotIn("\\", info.filename)
                else:
                    self.assertEqual(info.orig_filename, info.filename)
            result = run_extractor(archive_path, destination)

            self.assertNotEqual(0, result.returncode)
            self.assertIn("backslash", result.stderr)
            self.assertFalse(destination.exists())
            self.assert_no_staging(root, destination.name)

    def test_rejects_nul_in_orig_filename(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            # "nul.zip" itself is the Windows NUL device name.
            archive_path = root / "nul-member.zip"
            destination = root / "output"
            write_zip(archive_path, [("nulxx", b"x")])
            patch_member_name(archive_path, b"nu\x00xx")

            with zipfile.ZipFile(archive_path) as archive:
                self.assertIn("\x00", archive.infolist()[0].orig_filename)
            result = run_extractor(archive_path, destination)

            self.assertNotEqual(0, result.returncode)
            self.assertIn("NUL", result.stderr)
            self.assertFalse(destination.exists())
            self.assert_no_staging(root, destination.name)

    def test_rejects_casefold_and_unicode_normalization_duplicates(self):
        duplicate_sets = (
            (("Readme.txt", b"one"), ("README.TXT", b"two")),
            (("caf\u00e9.txt", b"one"), ("cafe\u0301.txt", b"two")),
        )
        for entries in duplicate_sets:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                archive_path = root / "duplicates.zip"
                destination = root / "output"
                write_zip(archive_path, entries)

                result = run_extractor(archive_path, destination)

                self.assertNotEqual(0, result.returncode)
                self.assertIn("duplicate", result.stderr.lower())
                self.assertFalse(destination.exists())
                self.assert_no_staging(root, destination.name)

    def test_rejects_file_directory_prefix_conflicts_in_either_order(self):
        conflict_sets = (
            (("prefix", b"file"), ("prefix/child.txt", b"child")),
            (("prefix/child.txt", b"child"), ("prefix", b"file")),
            (("same", b"file"), ("same/", b"")),
        )
        for entries in conflict_sets:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                archive_path = root / "prefix.zip"
                destination = root / "output"
                write_zip(archive_path, entries)

                result = run_extractor(archive_path, destination)

                self.assertNotEqual(0, result.returncode)
                self.assertFalse(destination.exists())
                self.assert_no_staging(root, destination.name)

    def test_rejects_symlink_special_and_unsupported_unix_modes(self):
        invalid_modes = (
            ("symlink", stat.S_IFLNK | 0o777, b"target"),
            ("fifo", stat.S_IFIFO | 0o644, b""),
            ("setuid", stat.S_IFREG | stat.S_ISUID | 0o755, b"x"),
        )
        for label, mode, data in invalid_modes:
            with self.subTest(mode=label), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                archive_path = root / f"{label}.zip"
                destination = root / "output"
                write_mode_zip(archive_path, label, mode, data)

                result = run_extractor(archive_path, destination)

                self.assertNotEqual(0, result.returncode)
                self.assertFalse(destination.exists())
                self.assert_no_staging(root, destination.name)

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "unsupported-creator.zip"
            destination = root / "output"
            write_mode_zip(archive_path, "file", stat.S_IFREG | 0o644, creator=7)
            result = run_extractor(archive_path, destination)
            self.assertNotEqual(0, result.returncode)
            self.assertIn("unsupported", result.stderr.lower())
            self.assertFalse(destination.exists())
            self.assert_no_staging(root, destination.name)

    def test_rejects_encryption_and_unsupported_compression(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            encrypted = root / "encrypted.zip"
            write_zip(encrypted, [("file.txt", b"payload")])
            patch_encrypted_flag(encrypted)
            encrypted_result = run_extractor(encrypted, root / "encrypted-output")
            self.assertNotEqual(0, encrypted_result.returncode)
            self.assertIn("Encrypted", encrypted_result.stderr)
            self.assertFalse((root / "encrypted-output").exists())
            self.assert_no_staging(root, "encrypted-output")

            for label, compression in (
                ("bzip2", zipfile.ZIP_BZIP2),
                ("lzma", zipfile.ZIP_LZMA),
            ):
                with self.subTest(compression=label):
                    compressed_archive = root / f"{label}.zip"
                    compressed_output = root / f"{label}-output"
                    write_zip(
                        compressed_archive,
                        [("file.txt", b"payload")],
                        compression=compression,
                    )
                    compression_result = run_extractor(compressed_archive, compressed_output)
                    self.assertNotEqual(0, compression_result.returncode)
                    self.assertIn("unsupported compression", compression_result.stderr)
                    self.assertFalse(compressed_output.exists())
                    self.assert_no_staging(root, compressed_output.name)

    def test_rejects_local_header_encryption_before_staging(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "local-encrypted.zip"
            destination = root / "output"
            write_zip(archive_path, [("safe.txt", b"safe"), ("encrypted.txt", b"secret")])
            patch_local_encrypted_flag(archive_path, entry_index=1)

            result = run_extractor(archive_path, destination)

            self.assertNotEqual(0, result.returncode)
            self.assertIn("Encrypted local", result.stderr)
            self.assertFalse(destination.exists())
            self.assert_no_staging(root, destination.name)

    def test_rejects_nonregular_empty_and_oversize_archives(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)

            archive_directory = root / "archive-directory"
            archive_directory.mkdir()
            directory_result = run_extractor(archive_directory, root / "directory-output")
            self.assertNotEqual(0, directory_result.returncode)
            self.assertIn("regular file", directory_result.stderr)
            self.assertFalse((root / "directory-output").exists())
            self.assert_no_staging(root, "directory-output")

            empty_archive = root / "empty.zip"
            empty_archive.touch()
            empty_result = run_extractor(empty_archive, root / "empty-output")
            self.assertNotEqual(0, empty_result.returncode)
            self.assertIn("non-empty", empty_result.stderr)
            self.assertFalse((root / "empty-output").exists())
            self.assert_no_staging(root, "empty-output")

            oversize_archive = root / "oversize.zip"
            with oversize_archive.open("wb") as output:
                output.truncate(EXTRACTOR.PROFILE_LIMITS["package"].max_archive_size + 1)
            oversize_result = run_extractor(oversize_archive, root / "oversize-output")
            self.assertNotEqual(0, oversize_result.returncode)
            self.assertIn("profile limit", oversize_result.stderr)
            self.assertFalse((root / "oversize-output").exists())
            self.assert_no_staging(root, "oversize-output")

    def test_rejects_archive_symlink_when_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "archive.zip"
            archive_link = root / "archive-link.zip"
            write_zip(archive_path, [("file.txt", b"payload")])
            try:
                os.symlink(str(archive_path), str(archive_link))
            except (OSError, NotImplementedError) as error:
                archive_stat = os.stat(str(archive_path))
                stat_values = list(archive_stat)
                stat_values[0] = stat.S_IFLNK | 0o777
                simulated_link_stat = os.stat_result(stat_values)
                with mock.patch.object(EXTRACTOR.os, "lstat", return_value=simulated_link_stat):
                    with self.assertRaisesRegex(EXTRACTOR.ExtractionError, "regular file"):
                        EXTRACTOR._open_regular_archive(
                            archive_path,
                            EXTRACTOR.PROFILE_LIMITS["package"],
                        )
                self.assertFalse((root / "output").exists(), str(error))
                return

            result = run_extractor(archive_link, root / "output")

            self.assertNotEqual(0, result.returncode)
            self.assertIn("regular file", result.stderr)
            self.assertFalse((root / "output").exists())
            self.assert_no_staging(root, "output")

    def test_rejects_entry_count_compressed_entry_total_and_ratio_limits(self):
        limits = EXTRACTOR.PROFILE_LIMITS["package"]

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "too-many.zip"
            with zipfile.ZipFile(archive_path, "w", allowZip64=True) as archive:
                for index in range(limits.max_entries + 1):
                    archive.writestr(f"entries/{index:05d}", b"")
            result = run_extractor(archive_path, root / "entry-output")
            self.assertNotEqual(0, result.returncode)
            self.assertIn("members", result.stderr)
            self.assertFalse((root / "entry-output").exists())
            self.assert_no_staging(root, "entry-output")

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "compressed-total.zip"
            write_zip(archive_path, [("one", b"x"), ("two", b"y")])
            seventy_mib = 70 * EXTRACTOR.MIB
            patch_all_central_sizes(
                archive_path,
                [seventy_mib, seventy_mib],
                [seventy_mib, seventy_mib],
            )
            result = run_extractor(archive_path, root / "compressed-output")
            self.assertNotEqual(0, result.returncode)
            self.assertIn("compressed-data limit", result.stderr)
            self.assertFalse((root / "compressed-output").exists())
            self.assert_no_staging(root, "compressed-output")

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "entry-size.zip"
            write_zip(archive_path, [("large", b"x")])
            patch_central_u32(
                archive_path,
                0,
                24,
                limits.max_entry_uncompressed + 1,
            )
            result = run_extractor(archive_path, root / "entry-size-output")
            self.assertNotEqual(0, result.returncode)
            self.assertIn("per-entry limit", result.stderr)
            self.assertFalse((root / "entry-size-output").exists())
            self.assert_no_staging(root, "entry-size-output")

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "total-size.zip"
            write_zip(archive_path, [("one", b"x"), ("two", b"y"), ("three", b"z")])
            eight_hundred_mib = 800 * EXTRACTOR.MIB
            eight_mib = 8 * EXTRACTOR.MIB
            patch_all_central_sizes(
                archive_path,
                [eight_mib, eight_mib, eight_mib],
                [eight_hundred_mib, eight_hundred_mib, eight_hundred_mib],
            )
            result = run_extractor(archive_path, root / "total-size-output")
            self.assertNotEqual(0, result.returncode)
            self.assertIn("total-uncompressed limit", result.stderr)
            self.assertFalse((root / "total-size-output").exists())
            self.assert_no_staging(root, "total-size-output")

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "ratio.zip"
            write_zip(archive_path, [("ratio", b"x")])
            patch_all_central_sizes(archive_path, [1], [limits.max_compression_ratio + 1])
            result = run_extractor(archive_path, root / "ratio-output")
            self.assertNotEqual(0, result.returncode)
            self.assertIn("compression ratio", result.stderr)
            self.assertFalse((root / "ratio-output").exists())
            self.assert_no_staging(root, "ratio-output")

    def test_build_environment_profile_rejects_wrong_shape_empty_and_oversize(self):
        invalid_entry_sets = (
            (("nested/BuildEnvironment.json", b"{}"),),
            (("BuildEnvironment.json/", b""),),
            (("BuildEnvironment.json", b"{}"), ("extra.txt", b"x")),
            (("BuildEnvironment.json", b""),),
            (("BuildEnvironment.json", b"x" * (64 * EXTRACTOR.KIB + 1)),),
        )
        for entries in invalid_entry_sets:
            with self.subTest(entries=[entry[0] for entry in entries]), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                archive_path = root / "environment.zip"
                destination = root / "output"
                write_zip(archive_path, entries)

                result = run_extractor(archive_path, destination, "build-environment")

                self.assertNotEqual(0, result.returncode)
                self.assertFalse(destination.exists())
                self.assert_no_staging(root, destination.name)

    def test_streaming_crc_failure_cleans_staging_and_publishes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "bad-crc.zip"
            destination = root / "output"
            write_zip(archive_path, [("file.txt", b"payload")])
            corrupt_first_member_payload(archive_path)

            result = run_extractor(archive_path, destination)

            self.assertNotEqual(0, result.returncode)
            self.assertIn("CRC", result.stderr)
            self.assertFalse(destination.exists())
            self.assert_no_staging(root, destination.name)

    def test_destination_is_no_overwrite_including_broken_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "package.zip"
            write_zip(archive_path, [("file.txt", b"new")])

            existing = root / "existing"
            existing.mkdir()
            (existing / "sentinel.txt").write_bytes(b"keep")
            existing_result = run_extractor(archive_path, existing)
            self.assertNotEqual(0, existing_result.returncode)
            self.assertEqual(b"keep", (existing / "sentinel.txt").read_bytes())
            self.assert_no_staging(root, existing.name)

            broken_link = root / "broken-link"
            try:
                os.symlink(str(root / "missing-target"), str(broken_link), target_is_directory=True)
            except (OSError, NotImplementedError):
                return
            self.assertTrue(os.path.lexists(broken_link))
            self.assertFalse(broken_link.exists())
            link_result = run_extractor(archive_path, broken_link)
            self.assertNotEqual(0, link_result.returncode)
            self.assertTrue(os.path.lexists(broken_link))
            self.assert_no_staging(root, broken_link.name)

    def test_atomic_publish_refuses_destination_created_during_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "package.zip"
            destination = root / "raced-output"
            write_zip(archive_path, [("file.txt", b"new")])
            original_extract = EXTRACTOR._extract_to_staging

            def extract_then_create_destination(*arguments, **keywords):
                original_extract(*arguments, **keywords)
                destination.mkdir()
                (destination / "sentinel.txt").write_bytes(b"keep")

            with mock.patch.object(
                EXTRACTOR,
                "_extract_to_staging",
                side_effect=extract_then_create_destination,
            ):
                with self.assertRaisesRegex(EXTRACTOR.ExtractionError, "appeared"):
                    EXTRACTOR.extract_verified_artifact(
                        archive_path,
                        destination,
                        "package",
                    )

            self.assertEqual(b"keep", (destination / "sentinel.txt").read_bytes())
            self.assertFalse((destination / "file.txt").exists())
            self.assert_no_staging(root, destination.name)

    def test_cleanup_failure_is_explicit_instead_of_silently_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            staging = pathlib.Path(directory) / ".output.extract-test"
            staging.mkdir()
            (staging / "file.txt").write_bytes(b"data")
            with mock.patch.object(
                EXTRACTOR.shutil,
                "rmtree",
                side_effect=OSError("simulated cleanup failure"),
            ):
                with self.assertRaisesRegex(EXTRACTOR.ExtractionError, "Failed to remove"):
                    EXTRACTOR._cleanup_staging(staging)
            self.assertTrue(staging.exists())

    def test_fresh_staging_does_not_reuse_or_delete_stale_lookalike(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive_path = root / "package.zip"
            destination = root / "output"
            stale = root / ".output.extract-stale"
            stale.mkdir()
            (stale / "sentinel.txt").write_bytes(b"keep")
            write_zip(archive_path, [("file.txt", b"new")])

            result = run_extractor(archive_path, destination)

            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual(b"new", (destination / "file.txt").read_bytes())
            self.assertEqual(b"keep", (stale / "sentinel.txt").read_bytes())


if __name__ == "__main__":
    unittest.main()
