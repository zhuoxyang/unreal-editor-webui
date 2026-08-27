from __future__ import annotations

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


sys.dont_write_bytecode = True
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_ROOT = REPOSITORY_ROOT / "scripts"
if str(SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_ROOT))

from tool_pack_distribution import (  # noqa: E402
    DISTRIBUTION_RELATIVE_PATH,
    DistributionError,
    doctor_installation,
    package_tool_pack,
)
import tool_pack_distribution as distribution  # noqa: E402


FIXTURE_ROOT = REPOSITORY_ROOT / "tests" / "fixtures" / "ue-tool-packs"


def copy_fixture(name: str, destination: Path) -> Path:
    source = FIXTURE_ROOT / name
    target = destination / name
    shutil.copytree(
        source,
        target,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
    )
    return target


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
            "utf-8"
        )
    )


def make_engine(root: Path, build_id: str = "fixture-build-55") -> Path:
    engine_root = root / "UE_5.5"
    write_json(
        engine_root / "Engine" / "Build" / "Build.version",
        {
            "MajorVersion": 5,
            "MinorVersion": 5,
            "PatchVersion": 4,
            "Changelist": 40574608,
            "CompatibleChangelist": 37670630,
        },
    )
    write_json(
        engine_root / "Engine" / "Binaries" / "Win64" / "UnrealEditor.modules",
        {"BuildId": build_id, "Modules": {}},
    )
    (engine_root / "Engine" / "Plugins").mkdir(parents=True)
    return engine_root


def make_packaged_code_plugin(
    plugin: Path,
    plugin_name: str,
    build_id: str = "fixture-build-55",
) -> None:
    descriptor_path = plugin / (plugin_name + ".uplugin")
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    descriptor["EngineVersion"] = "5.5.0"
    write_json(descriptor_path, descriptor)
    binary_name = "UnrealEditor-%s.dll" % plugin_name
    write_json(
        plugin / "Binaries" / "Win64" / "UnrealEditor.modules",
        {"BuildId": build_id, "Modules": {plugin_name: binary_name}},
    )
    (plugin / "Binaries" / "Win64" / binary_name).write_bytes(b"fixture-dll\0")


def make_core(root: Path, build_id: str = "fixture-build-55") -> Path:
    core = root / "UnrealEditorWebUI"
    core.mkdir(parents=True)
    write_json(
        core / "UnrealEditorWebUI.uplugin",
        {
            "FileVersion": 3,
            "Version": 4,
            "VersionName": "0.3.0",
            "CanContainContent": True,
            "EngineVersion": "5.5.0",
            "Modules": [
                {
                    "Name": "UnrealEditorWebUI",
                    "Type": "Editor",
                    "LoadingPhase": "Default",
                }
            ],
        },
    )
    make_packaged_code_plugin(core, "UnrealEditorWebUI", build_id)
    return core


def extract_result(result: object, destination: Path) -> Path:
    archive = result.output_directory / result.archive_name
    with zipfile.ZipFile(archive, "r") as package:
        package.extractall(destination)
    return destination / result.descriptor.plugin_name


class ToolPackPackagingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="uewebui-distribution-tests-")
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_content_only_package_is_byte_reproducible_and_canonical(self) -> None:
        plugin = copy_fixture("AssetToolsFixture", self.root / "input")
        first = package_tool_pack(str(plugin), str(self.root / "package-a"))

        for path in plugin.rglob("*"):
            if path.is_file():
                os.utime(path, (1_700_000_000, 1_700_000_000))
        second = package_tool_pack(str(plugin), str(self.root / "package-b"))

        first_archive = first.output_directory / first.archive_name
        second_archive = second.output_directory / second.archive_name
        self.assertEqual(first_archive.read_bytes(), second_archive.read_bytes())
        self.assertEqual(
            (first.output_directory / first.manifest_name).read_bytes(),
            (second.output_directory / second.manifest_name).read_bytes(),
        )
        self.assertEqual(
            (first.output_directory / (first.archive_name + ".sha256")).read_bytes(),
            (second.output_directory / (second.archive_name + ".sha256")).read_bytes(),
        )
        self.assertEqual(first.unreal_variant["kind"], "content_only")
        self.assertEqual(first.sha256_name, first.archive_name + ".sha256")
        self.assertEqual(
            sorted(path.name for path in first.output_directory.iterdir()),
            sorted([first.archive_name, first.manifest_name, first.sha256_name]),
        )

        sidecar = (first.output_directory / first.manifest_name).read_bytes()
        with zipfile.ZipFile(first_archive, "r") as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            self.assertEqual(names, sorted(names, key=lambda value: value.encode("utf-8")))
            self.assertFalse(any(info.is_dir() for info in infos))
            self.assertTrue(all(info.compress_type == zipfile.ZIP_STORED for info in infos))
            self.assertTrue(all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in infos))
            self.assertTrue(all(not info.extra and not info.comment for info in infos))
            self.assertTrue(all(not (info.flag_bits & 0x08) for info in infos))
            self.assertEqual(archive.comment, b"")
            embedded = archive.read(
                "AssetToolsFixture/" + DISTRIBUTION_RELATIVE_PATH.as_posix()
            )
            self.assertEqual(embedded, sidecar)

        sha_line = (
            first.output_directory / (first.archive_name + ".sha256")
        ).read_bytes()
        self.assertRegex(
            sha_line.decode("ascii"),
            r"\A[0-9a-f]{64}  AssetToolsFixture-1\.0\.0-ToolPack\.zip\n\Z",
        )

    def test_package_is_fresh_private_and_rejects_private_payload(self) -> None:
        plugin = copy_fixture("AssetToolsFixture", self.root / "input")
        existing_output = self.root / "existing"
        existing_output.mkdir()
        sentinel = existing_output / "keep.txt"
        sentinel.write_text("keep", encoding="utf-8")
        with self.assertRaises(DistributionError) as caught:
            package_tool_pack(str(plugin), str(existing_output))
        self.assertEqual(caught.exception.reason_code, "output_exists")
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

        with self.assertRaises(DistributionError) as caught:
            package_tool_pack(str(plugin), str(plugin / "package"))
        self.assertEqual(caught.exception.reason_code, "output_inside_plugin")

        (plugin / ".env.secret").write_text("private-token", encoding="utf-8")
        with self.assertRaises(DistributionError) as caught:
            package_tool_pack(str(plugin), str(self.root / "private-package"))
        self.assertEqual(caught.exception.reason_code, "payload_private_file")
        self.assertNotIn("private-token", caught.exception.message)
        self.assertEqual(
            list(self.root.glob(".tool-pack-package-*")),
            [],
        )

    def test_code_pack_requires_matching_explicit_engine_variant(self) -> None:
        engine = make_engine(self.root)
        plugin = copy_fixture("ExistingCodeToolPackFixture", self.root / "input")
        make_packaged_code_plugin(plugin, "ExistingCodeToolPackFixture")

        with self.assertRaises(DistributionError) as caught:
            package_tool_pack(str(plugin), str(self.root / "missing-engine"))
        self.assertEqual(caught.exception.reason_code, "ue_variant_metadata_missing")

        result = package_tool_pack(
            str(plugin),
            str(self.root / "code-package"),
            engine_root_value=str(engine),
        )
        self.assertEqual(result.unreal_variant["kind"], "precompiled")
        self.assertEqual(result.unreal_variant["moduleBuildId"], "fixture-build-55")

        modules_path = plugin / "Binaries" / "Win64" / "UnrealEditor.modules"
        modules = json.loads(modules_path.read_text(encoding="utf-8"))
        modules["BuildId"] = "wrong-build"
        write_json(modules_path, modules)
        with self.assertRaises(DistributionError) as caught:
            package_tool_pack(
                str(plugin),
                str(self.root / "wrong-code-package"),
                engine_root_value=str(engine),
            )
        self.assertEqual(caught.exception.reason_code, "ue_module_build_id_mismatch")

    def test_content_only_variant_is_explicit_and_has_no_binaries(self) -> None:
        plugin = copy_fixture("AssetToolsFixture", self.root / "input")
        descriptor_path = plugin / "AssetToolsFixture.uplugin"
        descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
        descriptor.pop("NoCode")
        write_json(descriptor_path, descriptor)
        with self.assertRaises(DistributionError) as caught:
            package_tool_pack(str(plugin), str(self.root / "missing-no-code"))
        self.assertEqual(caught.exception.reason_code, "ue_variant_metadata_missing")

        descriptor["NoCode"] = True
        write_json(descriptor_path, descriptor)
        (plugin / "Binaries").mkdir()
        with self.assertRaises(DistributionError) as caught:
            package_tool_pack(str(plugin), str(self.root / "ambiguous-binaries"))
        self.assertEqual(caught.exception.reason_code, "ue_variant_metadata_missing")

    def test_scan_limit_is_enforced_before_sorting_a_directory(self) -> None:
        plugin = copy_fixture("AssetToolsFixture", self.root / "input")
        with mock.patch.object(distribution, "MAX_SCAN_ENTRIES", 2):
            with self.assertRaises(DistributionError) as caught:
                package_tool_pack(str(plugin), str(self.root / "bounded"))
        self.assertEqual(caught.exception.reason_code, "scan_limit_exceeded")

    def test_cli_invalid_candidate_is_privacy_safe_json(self) -> None:
        private_root = self.root / "Users" / "secret-user"
        private_root.mkdir(parents=True)
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_ROOT / "package-tool-pack.py"),
                "--plugin-dir",
                str(private_root),
                "--output-dir",
                str(self.root / "unused"),
                "--format",
                "json",
            ],
            cwd=str(REPOSITORY_ROOT),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "")
        self.assertNotIn("secret-user", result.stdout)
        self.assertNotIn(str(self.root), result.stdout)
        self.assertEqual(json.loads(result.stdout)["issues"][0]["pluginName"], "candidate")


class ToolPackDoctorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="uewebui-doctor-secret-user-")
        self.root = Path(self.temp.name)
        self.engine = make_engine(self.root)
        self.project = self.root / "Project" / "Fixture.uproject"
        write_json(self.project, {"FileVersion": 3, "Plugins": []})
        self.external = self.root / "External"
        self.external.mkdir()
        make_core(self.external)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def package_and_install(self, fixture_name: str, output_name: str) -> object:
        plugin = copy_fixture(fixture_name, self.root / (output_name + "-input"))
        result = package_tool_pack(str(plugin), str(self.root / (output_name + "-package")))
        extract_result(result, self.external)
        return result

    def test_clean_core_and_two_packs_are_healthy_with_optional_trust(self) -> None:
        asset = self.package_and_install("AssetToolsFixture", "asset")
        level = self.package_and_install("LevelToolsFixture", "level")

        report = doctor_installation(
            str(self.project),
            str(self.engine),
            [str(self.external)],
        )
        self.assertTrue(report.healthy, report.public_document())
        self.assertEqual(report.integrity_status, "self_consistent")
        self.assertEqual(report.authenticity_status, "unverified")
        self.assertEqual(report.issues, ())

        trust_file = self.root / "tool-packs.lock.json"
        write_json(
            trust_file,
            {
                "schemaVersion": 1,
                "packs": [
                    {
                        "packId": asset.descriptor.pack_id,
                        "manifestSha256": asset.manifest_sha256,
                    },
                    {
                        "packId": level.descriptor.pack_id,
                        "manifestSha256": level.manifest_sha256,
                    },
                ],
            },
        )
        trusted = doctor_installation(
            str(self.project),
            str(self.engine),
            [str(self.external)],
            trust_file_value=str(trust_file),
        )
        self.assertTrue(trusted.healthy, trusted.public_document())
        self.assertEqual(trusted.authenticity_status, "verified")
        rendered = json.dumps(trusted.public_document(), ensure_ascii=False)
        self.assertNotIn("secret-user", rendered)
        self.assertNotIn(str(self.root), rendered)

    def test_duplicate_core_pack_conflict_and_disabled_dependency_fail_stably(self) -> None:
        self.package_and_install("AssetToolsFixture", "asset")
        duplicate_root = self.root / "Project" / "Plugins"
        duplicate_root.mkdir(parents=True)
        make_core(duplicate_root)

        duplicate = doctor_installation(
            str(self.project),
            str(self.engine),
            [str(self.external)],
        )
        self.assertFalse(duplicate.healthy)
        self.assertIn("core_duplicate", [issue.reason_code for issue in duplicate.issues])

        shutil.rmtree(duplicate_root)
        installed = self.external / "AssetToolsFixture"
        descriptor_path = installed / "AssetToolsFixture.uplugin"
        descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
        descriptor["Plugins"][0]["Enabled"] = False
        write_json(descriptor_path, descriptor)
        disabled = doctor_installation(
            str(self.project),
            str(self.engine),
            [str(self.external)],
        )
        self.assertFalse(disabled.healthy)
        self.assertIn(
            "core_dependency_disabled",
            [issue.reason_code for issue in disabled.issues],
        )

    def test_pack_id_conflict_rejects_both_valid_distributions(self) -> None:
        asset = self.package_and_install("AssetToolsFixture", "asset")
        level_plugin = copy_fixture("LevelToolsFixture", self.root / "level-input")
        manifest_path = level_plugin / "Content" / "UnrealEditorWebUI" / "ToolPack.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["id"] = asset.descriptor.pack_id
        write_json(manifest_path, manifest)
        level = package_tool_pack(str(level_plugin), str(self.root / "level-package"))
        extract_result(level, self.external)

        report = doctor_installation(
            str(self.project), str(self.engine), [str(self.external)]
        )
        self.assertFalse(report.healthy)
        self.assertEqual(
            [issue.reason_code for issue in report.issues].count("pack_id_conflict"),
            2,
        )
        self.assertEqual({pack.state for pack in report.packs}, {"rejected"})

    def test_wrong_case_manifest_is_discovered_and_rejected(self) -> None:
        self.package_and_install("AssetToolsFixture", "asset")
        installed = self.external / "AssetToolsFixture"
        content = installed / "Content"
        temporary = installed / "Content-case-change"
        content.rename(temporary)
        temporary.rename(installed / "content")

        report = doctor_installation(
            str(self.project), str(self.engine), [str(self.external)]
        )
        self.assertFalse(report.healthy)
        self.assertIn(
            "payload_path_case_invalid",
            [issue.reason_code for issue in report.issues],
        )
        self.assertTrue(all(pack.state == "rejected" for pack in report.packs))

    def test_published_marker_keeps_missing_contract_and_descriptor_visible(self) -> None:
        missing_paths = (
            Path("Content") / "UnrealEditorWebUI" / "ToolPack.json",
            Path("AssetToolsFixture.uplugin"),
        )
        for index, missing_path in enumerate(missing_paths):
            with self.subTest(missing_path=missing_path.as_posix()):
                installed = self.external / "AssetToolsFixture"
                if installed.exists():
                    shutil.rmtree(installed)
                self.package_and_install("AssetToolsFixture", "orphan-%d" % index)
                (installed / missing_path).unlink()

                report = doctor_installation(
                    str(self.project), str(self.engine), [str(self.external)]
                )
                self.assertFalse(report.healthy)
                self.assertEqual(len(report.packs), 1, report.public_document())
                self.assertEqual(report.packs[0].state, "rejected")
                self.assertIn(
                    "distribution_orphaned",
                    [issue.reason_code for issue in report.issues],
                )
                rendered = json.dumps(report.public_document(), ensure_ascii=False)
                self.assertNotIn("secret-user", rendered)
                self.assertNotIn(str(self.root), rendered)

    def test_doctor_cli_exit_code_contract(self) -> None:
        self.package_and_install("AssetToolsFixture", "cli-asset")
        command = [
            sys.executable,
            str(SCRIPTS_ROOT / "tool-pack-doctor.py"),
            "--project",
            str(self.project),
            "--engine-root",
            str(self.engine),
            "--external-root",
            str(self.external),
            "--format",
            "json",
        ]
        healthy = subprocess.run(
            command,
            cwd=str(REPOSITORY_ROOT),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(healthy.returncode, 0, healthy.stderr)
        self.assertEqual(json.loads(healthy.stdout)["overallStatus"], "healthy")

        shutil.rmtree(self.external / "UnrealEditorWebUI")
        unhealthy = subprocess.run(
            command,
            cwd=str(REPOSITORY_ROOT),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(unhealthy.returncode, 1, unhealthy.stderr)
        self.assertEqual(json.loads(unhealthy.stdout)["overallStatus"], "unhealthy")

        usage = subprocess.run(
            [sys.executable, str(SCRIPTS_ROOT / "tool-pack-doctor.py")],
            cwd=str(REPOSITORY_ROOT),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(usage.returncode, 2)

        spec = importlib.util.spec_from_file_location(
            "tool_pack_doctor_cli_test",
            SCRIPTS_ROOT / "tool-pack-doctor.py",
        )
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader if spec is not None else None)
        module = importlib.util.module_from_spec(spec)
        assert spec is not None and spec.loader is not None
        spec.loader.exec_module(module)
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(
            module,
            "doctor_installation",
            side_effect=RuntimeError,
        ):
            with mock.patch.object(sys, "stdout", stdout), mock.patch.object(
                sys,
                "stderr",
                stderr,
            ):
                internal = module.main(
                    [
                        "--project",
                        "project",
                        "--engine-root",
                        "engine",
                        "--format",
                        "json",
                    ]
                )
        self.assertEqual(internal, 3)
        self.assertEqual(json.loads(stdout.getvalue())["overallStatus"], "error")

    def test_tampered_missing_and_unexpected_payloads_have_stable_codes(self) -> None:
        self.package_and_install("AssetToolsFixture", "asset")
        installed = self.external / "AssetToolsFixture"
        commands = (
            installed
            / "Content"
            / "Python"
            / "ue_webui_asset_tools_fixture"
            / "commands.py"
        )
        commands.write_bytes(commands.read_bytes() + b"\n# tampered\n")
        tampered = doctor_installation(
            str(self.project), str(self.engine), [str(self.external)]
        )
        self.assertIn(
            "payload_hash_mismatch",
            [issue.reason_code for issue in tampered.issues],
        )

        shutil.rmtree(installed)
        self.package_and_install("AssetToolsFixture", "asset-again")
        installed = self.external / "AssetToolsFixture"
        commands = (
            installed
            / "Content"
            / "Python"
            / "ue_webui_asset_tools_fixture"
            / "commands.py"
        )
        commands.unlink()
        missing = doctor_installation(
            str(self.project), str(self.engine), [str(self.external)]
        )
        self.assertIn(
            "payload_file_missing",
            [issue.reason_code for issue in missing.issues],
        )

        shutil.rmtree(installed)
        self.package_and_install("AssetToolsFixture", "asset-third")
        installed = self.external / "AssetToolsFixture"
        (installed / "Content" / "unexpected.txt").write_text("extra", encoding="utf-8")
        unexpected = doctor_installation(
            str(self.project), str(self.engine), [str(self.external)]
        )
        self.assertIn(
            "payload_file_unexpected",
            [issue.reason_code for issue in unexpected.issues],
        )

    def test_trust_mismatch_and_missing_core_fail_without_paths(self) -> None:
        result = self.package_and_install("AssetToolsFixture", "asset")
        trust_file = self.root / "tool-packs.lock.json"
        write_json(
            trust_file,
            {
                "schemaVersion": 1,
                "packs": [
                    {
                        "packId": result.descriptor.pack_id,
                        "manifestSha256": "sha256:" + "0" * 64,
                    }
                ],
            },
        )
        mismatch = doctor_installation(
            str(self.project),
            str(self.engine),
            [str(self.external)],
            trust_file_value=str(trust_file),
        )
        self.assertIn(
            "trusted_manifest_mismatch",
            [issue.reason_code for issue in mismatch.issues],
        )

        shutil.rmtree(self.external / "UnrealEditorWebUI")
        missing = doctor_installation(
            str(self.project), str(self.engine), [str(self.external)]
        )
        self.assertIn("core_missing", [issue.reason_code for issue in missing.issues])
        rendered = json.dumps(missing.public_document(), ensure_ascii=False)
        self.assertNotIn("secret-user", rendered)
        self.assertNotIn(str(self.root), rendered)


if __name__ == "__main__":
    unittest.main()
