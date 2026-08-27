from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON_ROOT = REPOSITORY_ROOT / "Python"
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

import unreal_editor_webui_toolpacks as toolpacks
import unreal_editor_webui_toolpack_integrity as integrity


FIXTURE_ROOT = REPOSITORY_ROOT / "tests" / "fixtures" / "ue-tool-packs"


class ToolPackValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.temp_root = pathlib.Path(self.temp_directory.name)

    def tearDown(self) -> None:
        self.temp_directory.cleanup()

    def copy_fixture(self, fixture_name: str, suffix: str = "") -> pathlib.Path:
        target = self.temp_root / f"{fixture_name}{suffix}"
        shutil.copytree(FIXTURE_ROOT / fixture_name, target)
        return target

    @staticmethod
    def descriptor_path(plugin: pathlib.Path) -> pathlib.Path:
        return next(plugin.glob("*.uplugin"))

    @staticmethod
    def manifest_path(plugin: pathlib.Path) -> pathlib.Path:
        return plugin / toolpacks.MANIFEST_RELATIVE_PATH

    @staticmethod
    def read_json(path: pathlib.Path) -> dict[str, object]:
        return json.loads(path.read_text(encoding="utf-8-sig"))

    @staticmethod
    def write_json(path: pathlib.Path, value: object) -> None:
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def reason_code(self, plugin: pathlib.Path) -> str:
        result = toolpacks.validate_tool_pack_directory(plugin)
        self.assertFalse(result.valid)
        self.assertEqual(len(result.issues), 1)
        return result.issues[0].reason_code

    def make_v2(
        self,
        plugin: pathlib.Path,
        *,
        entry_modules: list[str] | None = None,
        pure_python_mode: str = "none",
        pure_python_tree_sha256: str | None = None,
        native_mode: str = "none",
    ) -> pathlib.Path:
        manifest_path = self.manifest_path(plugin)
        manifest = self.read_json(manifest_path)
        manifest.update(
            {
                "schemaVersion": 2,
                "entryModules": entry_modules or ["commands"],
                "dependencyPolicy": {
                    "purePython": {
                        "mode": pure_python_mode,
                        "treeSha256": pure_python_tree_sha256,
                    },
                    "native": {"mode": native_mode},
                },
            }
        )
        self.write_json(manifest_path, manifest)
        return plugin

    def test_content_only_and_existing_code_fixtures_are_valid(self) -> None:
        fixture_names = ("AssetToolsFixture", "ExistingCodeToolPackFixture")
        results = [
            toolpacks.validate_tool_pack_directory(FIXTURE_ROOT / fixture_name)
            for fixture_name in fixture_names
        ]

        self.assertTrue(all(result.valid for result in results))
        self.assertEqual(
            [result.descriptor.plugin_version for result in results],
            ["1.0.0", "2.4.1"],
        )
        report = toolpacks.validate_tool_pack_directories(
            [FIXTURE_ROOT / fixture_name for fixture_name in reversed(fixture_names)]
        )
        self.assertTrue(report.valid)
        self.assertEqual(
            [descriptor.plugin_name for descriptor in report.descriptors],
            ["AssetToolsFixture", "ExistingCodeToolPackFixture"],
        )

    def test_schema_v2_entry_modules_are_closed_bounded_and_exact(self) -> None:
        valid = self.make_v2(self.copy_fixture("AssetToolsFixture", "V2Valid"))
        valid_result = toolpacks.validate_tool_pack_directory(valid)
        self.assertTrue(valid_result.valid)
        self.assertEqual(valid_result.descriptor.schema_version, 2)
        self.assertEqual(valid_result.descriptor.entry_modules, ("commands",))

        cases = (
            (["../commands"], "entry_module_invalid"),
            (["commands", "commands"], "entry_module_duplicate"),
            (["missing"], "entry_module_missing"),
            (["commands"] * (toolpacks.MAX_ENTRY_MODULE_COUNT + 1), "entry_modules_invalid"),
        )
        for index, (entries, reason_code) in enumerate(cases):
            with self.subTest(reason_code=reason_code):
                plugin = self.make_v2(
                    self.copy_fixture("AssetToolsFixture", f"V2Entries{index}"),
                    entry_modules=entries,
                )
                self.assertEqual(self.reason_code(plugin), reason_code)

        ambiguous = self.make_v2(
            self.copy_fixture("AssetToolsFixture", "V2Ambiguous")
        )
        package = (
            ambiguous
            / "Content"
            / "Python"
            / "ue_webui_asset_tools_fixture"
        )
        (package / "commands" / "__init__.py").mkdir(parents=True)
        self.assertEqual(self.reason_code(ambiguous), "entry_module_ambiguous")

        oversized = self.make_v2(
            self.copy_fixture("AssetToolsFixture", "V2Oversized")
        )
        self.manifest_path(oversized).write_bytes(
            b"{" + b" " * toolpacks.MAX_MANIFEST_BYTES + b"}"
        )
        self.assertEqual(self.reason_code(oversized), "manifest_json_invalid")

    def test_schema_v2_dependency_policy_requires_real_hash_lock(self) -> None:
        closed = self.make_v2(self.copy_fixture("AssetToolsFixture", "V2Closed"))
        closed_manifest = self.read_json(self.manifest_path(closed))
        closed_manifest["dependencyPolicy"]["unexpected"] = True
        self.write_json(self.manifest_path(closed), closed_manifest)
        self.assertEqual(self.reason_code(closed), "dependency_policy_invalid")

        unlocked = self.make_v2(
            self.copy_fixture("AssetToolsFixture", "V2Unlocked")
        )
        unlocked_vendor = (
            unlocked
            / "Content"
            / "Python"
            / "ue_webui_asset_tools_fixture"
            / "_vendor"
        )
        unlocked_vendor.mkdir()
        (unlocked_vendor / "__init__.py").write_text("", encoding="utf-8")
        self.assertEqual(
            self.reason_code(unlocked),
            "unlocked_vendored_dependencies",
        )

        vendored = self.copy_fixture("AssetToolsFixture", "V2Vendored")
        vendor = (
            vendored
            / "Content"
            / "Python"
            / "ue_webui_asset_tools_fixture"
            / "_vendor"
        )
        vendor.mkdir()
        (vendor / "__init__.py").write_text("", encoding="utf-8")
        dependency = vendor / "dependency.py"
        dependency.write_text("VALUE = 1\n", encoding="utf-8")
        digest = integrity.compute_bounded_directory_sha256(vendor)
        self.make_v2(
            vendored,
            pure_python_mode="vendored",
            pure_python_tree_sha256=digest,
        )
        self.assertTrue(toolpacks.validate_tool_pack_directory(vendored).valid)
        dependency.write_text("VALUE = 2\n", encoding="utf-8")
        self.assertEqual(self.reason_code(vendored), "dependency_hash_mismatch")

        native = self.make_v2(
            self.copy_fixture("AssetToolsFixture", "V2Native")
        )
        native_file = (
            native
            / "Content"
            / "Python"
            / "ue_webui_asset_tools_fixture"
            / "dependency.pyd"
        )
        native_file.write_bytes(b"not-a-native-library")
        self.assertEqual(
            self.reason_code(native),
            "in_process_native_dependency_unsupported",
        )

    def test_startup_hook_is_rejected_for_v1_and_v2_as_security_exception(self) -> None:
        for schema_version in (1, 2):
            with self.subTest(schema_version=schema_version):
                plugin = self.copy_fixture(
                    "AssetToolsFixture", f"StartupV{schema_version}"
                )
                if schema_version == 2:
                    self.make_v2(plugin)
                (plugin / "Content" / "Python" / "init_unreal.py").write_text(
                    "raise RuntimeError('must never run')\n",
                    encoding="utf-8",
                )
                self.assertEqual(self.reason_code(plugin), "startup_hook_forbidden")

    def test_project_policy_schema_is_fixed_closed_bounded_and_duplicate_safe(self) -> None:
        project_root = self.temp_root / "PolicyProject"
        project_root.mkdir()
        self.assertIsNone(integrity.load_project_tool_pack_policy(project_root))
        policy_path = project_root / integrity.POLICY_RELATIVE_PATH
        policy_path.parent.mkdir(parents=True)
        valid = {
            "format": integrity.POLICY_FORMAT,
            "schemaVersion": integrity.POLICY_SCHEMA_VERSION,
            "packs": [
                {
                    "packId": "com.example.policy",
                    "pluginVersion": "1.0.0",
                    "requiredCoreApi": 1,
                    "payloadSha256": "sha256:" + "a" * 64,
                }
            ],
        }
        self.write_json(policy_path, valid)
        parsed = integrity.load_project_tool_pack_policy(project_root)
        self.assertEqual(parsed.entries[0].pack_id, "com.example.policy")

        invalid_documents = []
        unknown = json.loads(json.dumps(valid))
        unknown["unknown"] = True
        invalid_documents.append(unknown)
        boolean_schema_version = json.loads(json.dumps(valid))
        boolean_schema_version["schemaVersion"] = True
        invalid_documents.append(boolean_schema_version)
        duplicate = json.loads(json.dumps(valid))
        duplicate["packs"].append(dict(duplicate["packs"][0]))
        invalid_documents.append(duplicate)
        invalid_version = json.loads(json.dumps(valid))
        invalid_version["packs"][0]["pluginVersion"] = "unsafe version"
        invalid_documents.append(invalid_version)
        invalid_api = json.loads(json.dumps(valid))
        invalid_api["packs"][0]["requiredCoreApi"] = True
        invalid_documents.append(invalid_api)
        invalid_hash = json.loads(json.dumps(valid))
        invalid_hash["packs"][0]["payloadSha256"] = "sha256:not-a-digest"
        invalid_documents.append(invalid_hash)
        too_many = json.loads(json.dumps(valid))
        too_many["packs"] = [
            {
                "packId": f"com.example.pack-{index}",
                "pluginVersion": "1.0.0",
                "requiredCoreApi": 1,
                "payloadSha256": "sha256:" + "b" * 64,
            }
            for index in range(integrity.MAX_POLICY_PACKS + 1)
        ]
        invalid_documents.append(too_many)
        for index, document in enumerate(invalid_documents):
            with self.subTest(index=index):
                self.write_json(policy_path, document)
                with self.assertRaises(integrity.ToolPackIntegrityError) as raised:
                    integrity.load_project_tool_pack_policy(project_root)
                self.assertEqual(raised.exception.reason_code, "trust_policy_invalid")

        policy_path.write_text(
            '{"format":"unreal-editor-webui-tool-pack-policy",'
            '"schemaVersion":1,"schemaVersion":1,"packs":[]}',
            encoding="utf-8",
        )
        with self.assertRaises(integrity.ToolPackIntegrityError) as duplicate_field:
            integrity.load_project_tool_pack_policy(project_root)
        self.assertEqual(
            duplicate_field.exception.reason_code,
            "trust_policy_invalid",
        )

        policy_path.write_text(
            '{"format":"unreal-editor-webui-tool-pack-policy",'
            '"schemaVersion":1,"packs":[{"packId":"com.example.large-int",'
            '"pluginVersion":"1.0.0","requiredCoreApi":'
            + "1" * 5000
            + ',"payloadSha256":"sha256:'
            + "a" * 64
            + '"}]}',
            encoding="utf-8",
        )
        with self.assertRaises(integrity.ToolPackIntegrityError) as large_integer:
            integrity.load_project_tool_pack_policy(project_root)
        self.assertEqual(
            large_integer.exception.reason_code,
            "trust_policy_invalid",
        )

    def test_descriptor_and_manifest_json_are_strict(self) -> None:
        descriptor_plugin = self.copy_fixture("AssetToolsFixture", "Descriptor")
        self.descriptor_path(descriptor_plugin).write_text(
            (
                '{"VersionName":"1.0.0","CanContainContent":true,'
                '"Plugins":[],"\\u0050lugins":[]}\n'
            ),
            encoding="utf-8",
        )
        self.assertEqual(
            self.reason_code(descriptor_plugin),
            "plugin_descriptor_json_duplicate",
        )

        manifest_plugin = self.copy_fixture("AssetToolsFixture", "Manifest")
        self.manifest_path(manifest_plugin).write_text(
            '{"schemaVersion":1,"\\u0073chemaVersion":1}\n',
            encoding="utf-8",
        )
        self.assertEqual(
            self.reason_code(manifest_plugin),
            "manifest_json_duplicate",
        )

        malformed_plugin = self.copy_fixture("AssetToolsFixture", "Malformed")
        self.manifest_path(malformed_plugin).write_text(
            '{"schemaVersion":1\n',
            encoding="utf-8",
        )
        self.assertEqual(
            self.reason_code(malformed_plugin),
            "manifest_json_invalid",
        )

        nonfinite_plugin = self.copy_fixture("AssetToolsFixture", "Nonfinite")
        self.descriptor_path(nonfinite_plugin).write_text(
            (
                '{"Version":NaN,"VersionName":"1.0.0",'
                '"CanContainContent":true,"Plugins":['
                '{"Name":"UnrealEditorWebUI","Enabled":true}]}\n'
            ),
            encoding="utf-8",
        )
        self.assertEqual(
            self.reason_code(nonfinite_plugin),
            "plugin_descriptor_json_invalid",
        )

    def test_dependency_and_version_reason_codes_are_specific(self) -> None:
        cases = (
            ("Missing", [], "core_dependency_missing"),
            (
                "Duplicate",
                [
                    {"Name": "UnrealEditorWebUI", "Enabled": True},
                    {"Name": "UnrealEditorWebUI", "Enabled": False},
                ],
                "core_dependency_duplicate",
            ),
            (
                "Disabled",
                [{"Name": "UnrealEditorWebUI", "Enabled": False}],
                "core_dependency_disabled",
            ),
        )
        for suffix, dependencies, reason_code in cases:
            with self.subTest(reason_code=reason_code):
                plugin = self.copy_fixture("AssetToolsFixture", suffix)
                descriptor_path = self.descriptor_path(plugin)
                descriptor = self.read_json(descriptor_path)
                descriptor["Plugins"] = dependencies
                self.write_json(descriptor_path, descriptor)
                self.assertEqual(self.reason_code(plugin), reason_code)

        missing_version = self.copy_fixture("AssetToolsFixture", "MissingVersion")
        descriptor_path = self.descriptor_path(missing_version)
        descriptor = self.read_json(descriptor_path)
        del descriptor["VersionName"]
        self.write_json(descriptor_path, descriptor)
        self.assertEqual(
            self.reason_code(missing_version),
            "plugin_version_missing",
        )

        invalid_version = self.copy_fixture("AssetToolsFixture", "InvalidVersion")
        descriptor_path = self.descriptor_path(invalid_version)
        descriptor = self.read_json(descriptor_path)
        descriptor["VersionName"] = "unsafe version/path"
        self.write_json(descriptor_path, descriptor)
        self.assertEqual(
            self.reason_code(invalid_version),
            "plugin_version_invalid",
        )

    def test_manifest_api_namespace_and_package_files_fail_closed(self) -> None:
        incompatible = self.copy_fixture("AssetToolsFixture", "Api")
        manifest_path = self.manifest_path(incompatible)
        manifest = self.read_json(manifest_path)
        manifest["requiredCoreApi"] = 2
        self.write_json(manifest_path, manifest)
        self.assertEqual(self.reason_code(incompatible), "core_api_incompatible")

        reserved = self.copy_fixture("AssetToolsFixture", "Reserved")
        manifest_path = self.manifest_path(reserved)
        manifest = self.read_json(manifest_path)
        manifest["commandNamespace"] = "system.studio"
        self.write_json(manifest_path, manifest)
        self.assertEqual(self.reason_code(reserved), "command_namespace_reserved")

        escaping = self.copy_fixture("AssetToolsFixture", "Escaping")
        manifest_path = self.manifest_path(escaping)
        manifest = self.read_json(manifest_path)
        manifest["pythonPackage"] = "../private_package"
        self.write_json(manifest_path, manifest)
        self.assertEqual(self.reason_code(escaping), "python_package_invalid")

        missing_init = self.copy_fixture("AssetToolsFixture", "Init")
        manifest = self.read_json(self.manifest_path(missing_init))
        init_path = (
            missing_init
            / "Content"
            / "Python"
            / str(manifest["pythonPackage"])
            / "__init__.py"
        )
        init_path.unlink()
        self.assertEqual(self.reason_code(missing_init), "python_init_missing")

        no_manifest = self.copy_fixture("AssetToolsFixture", "NoManifest")
        self.manifest_path(no_manifest).unlink()
        self.assertEqual(self.reason_code(no_manifest), "manifest_missing")
        skipped = toolpacks.validate_tool_pack_directory(
            no_manifest,
            allow_missing_manifest=True,
        )
        self.assertEqual(skipped.state, "not_tool_pack")
        self.assertEqual(skipped.issues, ())

    def test_multi_pack_conflicts_reject_every_side(self) -> None:
        def pair(label: str) -> tuple[pathlib.Path, pathlib.Path]:
            return (
                self.copy_fixture("AssetToolsFixture", label + "A"),
                self.copy_fixture("LevelToolsFixture", label + "B"),
            )

        id_left, id_right = pair("Id")
        left_manifest = self.read_json(self.manifest_path(id_left))
        right_manifest = self.read_json(self.manifest_path(id_right))
        right_manifest["id"] = left_manifest["id"]
        self.write_json(self.manifest_path(id_right), right_manifest)
        id_report = toolpacks.validate_tool_pack_directories([id_right, id_left])
        self.assertEqual(
            [issue.reason_code for issue in id_report.issues],
            ["pack_id_conflict", "pack_id_conflict"],
        )
        self.assertEqual(id_report.descriptors, ())

        package_left, package_right = pair("Package")
        for plugin, package in (
            (package_left, "vendor.alpha"),
            (package_right, "vendor.beta"),
        ):
            manifest_path = self.manifest_path(plugin)
            manifest = self.read_json(manifest_path)
            manifest["pythonPackage"] = package
            self.write_json(manifest_path, manifest)
            package_directory = plugin / "Content" / "Python" / pathlib.Path(
                *package.split(".")
            )
            package_directory.mkdir(parents=True)
            (package_directory.parent / "__init__.py").write_text("", encoding="utf-8")
            (package_directory / "__init__.py").write_text("", encoding="utf-8")
        package_report = toolpacks.validate_tool_pack_directories(
            [package_right, package_left]
        )
        self.assertEqual(
            [issue.reason_code for issue in package_report.issues],
            ["python_package_conflict", "python_package_conflict"],
        )
        self.assertEqual(package_report.descriptors, ())

        namespace_left, namespace_right = pair("Namespace")
        for plugin, namespace in (
            (namespace_left, "studio.assets"),
            (namespace_right, "studio.assets.validate"),
        ):
            manifest_path = self.manifest_path(plugin)
            manifest = self.read_json(manifest_path)
            manifest["commandNamespace"] = namespace
            self.write_json(manifest_path, manifest)
        namespace_report = toolpacks.validate_tool_pack_directories(
            [namespace_right, namespace_left]
        )
        self.assertEqual(
            [issue.reason_code for issue in namespace_report.issues],
            ["command_namespace_conflict", "command_namespace_conflict"],
        )
        self.assertEqual(namespace_report.descriptors, ())

    def test_reparse_points_and_bounded_tree_scans_are_rejected(self) -> None:
        bounded = self.copy_fixture("AssetToolsFixture", "Bounded")
        with mock.patch.object(toolpacks, "MAX_TREE_ENTRIES", 2):
            self.assertEqual(self.reason_code(bounded), "scan_limit_exceeded")

        linked = self.copy_fixture("AssetToolsFixture", "Linked")
        manifest = self.read_json(self.manifest_path(linked))
        package_directory = (
            linked
            / "Content"
            / "Python"
            / str(manifest["pythonPackage"])
        )
        shutil.rmtree(package_directory)
        external = self.temp_root / "private-external-package"
        external.mkdir()
        (external / "__init__.py").write_text("", encoding="utf-8")
        linked_created = False
        try:
            try:
                package_directory.symlink_to(external, target_is_directory=True)
                linked_created = True
            except OSError as exc:
                if sys.platform != "win32":
                    self.skipTest(f"Directory symlinks are unavailable: {exc}")
                junction = subprocess.run(
                    [
                        "cmd.exe",
                        "/d",
                        "/c",
                        "mklink",
                        "/J",
                        str(package_directory),
                        str(external),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                if junction.returncode != 0:
                    self.skipTest("Directory links are unavailable on this host.")
                linked_created = True
            self.assertEqual(self.reason_code(linked), "path_reparse_point")
        finally:
            if linked_created and os.path.lexists(package_directory):
                if sys.platform == "win32":
                    os.rmdir(package_directory)
                else:
                    package_directory.unlink()


if __name__ == "__main__":
    unittest.main()
