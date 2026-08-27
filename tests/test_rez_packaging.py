from __future__ import annotations

import copy
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
REZ_ROOT = REPOSITORY_ROOT / "rez"
SCRIPTS_ROOT = REPOSITORY_ROOT / "scripts"
PYTHON_ROOT = REPOSITORY_ROOT / "Python"
for path in (REZ_ROOT, SCRIPTS_ROOT, PYTHON_ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import rez_payload
from tool_pack_distribution import package_tool_pack


class _EnvValue:
    def __init__(self) -> None:
        self.values: list[str] = []
        self.value: str | None = None

    def append(self, value: str) -> None:
        self.values.append(value)


class _Env:
    def __init__(self) -> None:
        object.__setattr__(self, "variables", {})

    def __getattr__(self, name: str) -> _EnvValue:
        return self.variables.setdefault(name, _EnvValue())

    def __setattr__(self, name: str, value: str) -> None:
        variable = self.variables.setdefault(name, _EnvValue())
        variable.value = value


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def _core_plugin(root: Path, variant: dict[str, object]) -> Path:
    plugin = root / "UnrealEditorWebUI"
    association = str(variant["engineAssociation"])
    build_id = str(variant["engine"]["buildId"])
    _write_json(
        plugin / "UnrealEditorWebUI.uplugin",
        {
            "FileVersion": 3,
            "Version": 4,
            "VersionName": "0.3.0",
            "Installed": True,
            "EngineVersion": association + ".0",
            "Modules": [
                {"Name": "UnrealEditorWebUI", "Type": "Editor", "LoadingPhase": "Default"}
            ],
        },
    )
    _write_json(
        plugin / "Binaries" / "Win64" / "UnrealEditor.modules",
        {
            "BuildId": build_id,
            "Modules": {"UnrealEditorWebUI": "UnrealEditor-UnrealEditorWebUI.dll"},
        },
    )
    files = {
        "Binaries/Win64/UnrealEditor-UnrealEditorWebUI.dll": b"precompiled-dll-" + build_id.encode(),
        "LICENSE": b"fixture-license\n",
        "Python/unreal_editor_webui_registry.py": b"COMMANDS = {}\n",
        "Source/UnrealEditorWebUI/private.cpp": b"must be pruned\n",
        "Intermediate/stale.bin": b"must be pruned\n",
        "SourceManifest.json": b'{"schemaVersion":1}\n',
        "Web/dist/index.html": b"<!doctype html><title>fixture</title>\n",
    }
    for relative, data in files.items():
        path = plugin / Path(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return plugin


def _engine_root(root: Path, variant: dict[str, object]) -> Path:
    engine = variant["engine"]
    _write_json(
        root / "Engine" / "Build" / "Build.version",
        {
            "MajorVersion": engine["majorVersion"],
            "MinorVersion": engine["minorVersion"],
            "PatchVersion": engine["patchVersion"],
            "Changelist": engine["changelist"],
            "CompatibleChangelist": engine["compatibleChangelist"],
            "BranchName": engine["branchName"],
        },
    )
    _write_json(
        root / "Engine" / "Binaries" / "Win64" / "UnrealEditor.version",
        {
            "MajorVersion": engine["majorVersion"],
            "MinorVersion": engine["minorVersion"],
            "PatchVersion": engine["patchVersion"],
            "Changelist": engine["changelist"],
            "CompatibleChangelist": engine["compatibleChangelist"],
            "BranchName": engine["branchName"],
            "BuildId": engine["buildId"],
        },
    )
    _write_json(
        root / "Engine" / "Binaries" / "Win64" / "UnrealEditor.modules",
        {"BuildId": engine["buildId"], "Modules": {}},
    )
    (root / "Engine" / "Plugins").mkdir(parents=True)
    return root


def _project(root: Path) -> Path:
    project = root / "RezHost.uproject"
    _write_json(
        project,
        {
            "FileVersion": 3,
            "EngineAssociation": "5.4",
            "Plugins": [
                {"Name": "UnrealEditorWebUI", "Enabled": True},
                {"Name": "AssetToolsFixture", "Enabled": True, "Optional": True},
                {"Name": "LevelToolsFixture", "Enabled": True, "Optional": True},
            ],
        },
    )
    return project


class RezPackagingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="uewebui-rez-test-")
        self.root = Path(self.temporary.name)
        self.payloads = self.root / "payloads"
        self.payloads.mkdir()
        self.variants = list(rez_payload.load_variants())
        self.core_archives: dict[str, Path] = {}
        for variant in self.variants:
            source = self.root / "core-source" / variant["id"]
            plugin = _core_plugin(source, variant)
            archive = self.payloads / f"UnrealEditorWebUI-v0.3.0-{variant['releaseVariant']}.zip"
            rez_payload.create_deterministic_archive(plugin, archive)
            self.core_archives[variant["id"]] = archive
        self.pack_archives: dict[str, Path] = {}
        fixture_by_recipe = {
            "unreal_editor_webui_asset_tools": REPOSITORY_ROOT
            / "tests/fixtures/ue-tool-packs/AssetToolsFixture",
            "unreal_editor_webui_level_tools": REPOSITORY_ROOT
            / "tests/fixtures/ue-tool-packs/LevelToolsFixture",
        }
        for recipe, fixture in fixture_by_recipe.items():
            fixture_copy = self.root / "pack-source" / recipe
            shutil.copytree(
                fixture,
                fixture_copy,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
            )
            output = self.root / "pack-output" / recipe
            output.parent.mkdir(parents=True, exist_ok=True)
            result = package_tool_pack(fixture_copy, output)
            source = output / result.archive_name
            archive = self.payloads / result.archive_name
            shutil.copyfile(source, archive)
            self.pack_archives[recipe] = archive
        self.lock = rez_payload.create_lock(self.core_archives, self.pack_archives)
        self.lock_bytes = rez_payload.canonical_json_bytes(self.lock)
        self.lock_path = self.root / "payload-lock.json"
        self.lock_path.write_bytes(self.lock_bytes)
        self.lock_sha = rez_payload._sha256_bytes(self.lock_bytes)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _install_all(self, variant_index: int = 0) -> tuple[Path, Path, Path]:
        core = self.root / "installed" / "core"
        asset = self.root / "installed" / "asset"
        level = self.root / "installed" / "level"
        rez_payload.install_locked_payload(
            self.lock,
            self.payloads,
            core,
            kind="core",
            recipe="unreal_editor_webui",
            variant_index=variant_index,
        )
        rez_payload.install_locked_payload(
            self.lock,
            self.payloads,
            asset,
            kind="tool_pack",
            recipe="unreal_editor_webui_asset_tools",
            variant_index=None,
        )
        rez_payload.install_locked_payload(
            self.lock,
            self.payloads,
            level,
            kind="tool_pack",
            recipe="unreal_editor_webui_level_tools",
            variant_index=None,
        )
        return core, asset, level

    def test_recipes_are_closed_offline_and_append_external_plugin_roots(self) -> None:
        core_text = (REZ_ROOT / "packages/unreal_editor_webui/package.py").read_text()
        self.assertIn('["unreal_engine==5.4.4"]', core_text)
        self.assertIn('["unreal_engine==5.5.4"]', core_text)
        self.assertIn('["unreal_engine==5.8.0"]', core_text)
        self.assertIn('env.UE_ADDITIONAL_PLUGIN_PATHS.append("{root}/Plugins")', core_text)
        self.assertIn('env.UNREAL_EDITOR_WEBUI_ROOT = "{root}/Plugins/UnrealEditorWebUI"', core_text)
        core_namespace: dict[str, object] = {}
        exec(core_text, core_namespace)
        self.assertEqual(core_namespace["version"], rez_payload.CORE_VERSION)
        self.assertEqual(
            core_namespace["variants"],
            [
                ["unreal_engine==5.4.4"],
                ["unreal_engine==5.5.4"],
                ["unreal_engine==5.8.0"],
            ],
        )
        self.assertEqual(
            core_namespace["tests"],
            {"payload": "uewebui-rez-verify --package unreal_editor_webui"},
        )
        self.assertIn("uewebui-rez-verify", core_namespace["tools"])
        for pack_recipe in (
            "unreal_editor_webui_asset_tools",
            "unreal_editor_webui_level_tools",
        ):
            pack_namespace: dict[str, object] = {}
            exec(
                (REZ_ROOT / "packages" / pack_recipe / "package.py").read_text(
                    encoding="utf-8"
                ),
                pack_namespace,
            )
            self.assertEqual(
                pack_namespace["requires"], ["unreal_editor_webui==0.3.0"]
            )
            self.assertEqual(
                pack_namespace["tests"],
                {
                    "payload": f"uewebui-rez-verify --package {pack_recipe}"
                },
            )
        aggregate = (REZ_ROOT / "packages/unreal_editor_webui_project/package.py").read_text()
        aggregate_namespace: dict[str, object] = {}
        exec(aggregate, aggregate_namespace)
        aggregate_tests = aggregate_namespace["tests"]
        self.assertEqual(
            aggregate_namespace["variants"],
            [
                [
                    "platform-windows",
                    "arch-AMD64",
                    f"unreal_engine=={engine_version}",
                    "unreal_editor_webui==0.3.0",
                    "unreal_editor_webui_asset_tools==1.0.0",
                    "unreal_editor_webui_level_tools==1.0.0",
                ]
                for engine_version in ("5.4.4", "5.5.4", "5.8.0")
            ],
        )
        self.assertTrue(all(isinstance(command, str) for command in aggregate_tests.values()))
        self.assertEqual(
            aggregate_tests,
            {
                "core-payload": "uewebui-rez-verify --package unreal_editor_webui",
                "asset-tools-payload": "uewebui-rez-verify --package unreal_editor_webui_asset_tools",
                "level-tools-payload": "uewebui-rez-verify --package unreal_editor_webui_level_tools",
            },
        )
        for pin in (
            '"unreal_editor_webui==0.3.0"',
            '"unreal_editor_webui_asset_tools==1.0.0"',
            '"unreal_editor_webui_level_tools==1.0.0"',
        ):
            self.assertEqual(aggregate.count(pin), 3)
        recipe_sources = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (REZ_ROOT / "packages").rglob("*.py")
        ).casefold()
        for forbidden in ("curl ", "wget ", "runuat", "npm install", "pip install"):
            self.assertNotIn(forbidden, recipe_sources)
        for non_exact_request in (
            '"unreal_engine-',
            '"unreal_editor_webui-0.',
            '"unreal_editor_webui_asset_tools-',
            '"unreal_editor_webui_level_tools-',
        ):
            self.assertNotIn(non_exact_request, recipe_sources)
        rez_docs = (REPOSITORY_ROOT / "docs/rez-packaging.md").read_text(
            encoding="utf-8"
        )
        for exact_request in (
            "unreal_engine==5.4.4",
            "unreal_engine==5.5.4",
            "unreal_engine==5.8.0",
            "rez-test unreal_editor_webui==0.3.0",
            "rez-env unreal_editor_webui_project==1.0.0 unreal_engine==5.5.4",
        ):
            self.assertIn(exact_request, rez_docs)
        for non_exact_request in (
            "unreal_engine-5.4.4",
            "unreal_engine-5.5.4",
            "unreal_engine-5.8.0",
            "rez-test unreal_editor_webui-0.3.0",
            "rez-env unreal_editor_webui_project-1.0.0",
        ):
            self.assertNotIn(non_exact_request, rez_docs)
        self.assertEqual(recipe_sources.count('build_command = \'rez-python "{root}/build.py"\''), 3)
        self.assertEqual(
            json.loads(
                (REPOSITORY_ROOT / "UnrealEditorWebUI.uplugin").read_text()
            )["VersionName"],
            rez_payload.CORE_VERSION,
        )
        ue_workflow = (
            REPOSITORY_ROOT / ".github/workflows/ue-ci.yml"
        ).read_text(encoding="utf-8")
        self.assertIn(
            f'UnrealEditorWebUI-v{rez_payload.CORE_VERSION}-$ReleaseVariant.zip',
            ue_workflow,
        )

    def test_recipe_commands_append_each_independent_plugins_root(self) -> None:
        env = _Env()
        for relative in (
            "packages/unreal_editor_webui/package.py",
            "packages/unreal_editor_webui_asset_tools/package.py",
            "packages/unreal_editor_webui_level_tools/package.py",
        ):
            namespace: dict[str, object] = {"env": env}
            exec((REZ_ROOT / relative).read_text(encoding="utf-8"), namespace)
            namespace["commands"]()
        self.assertEqual(
            env.variables["UE_ADDITIONAL_PLUGIN_PATHS"].values,
            ["{root}/Plugins", "{root}/Plugins", "{root}/Plugins"],
        )
        self.assertEqual(env.variables["UNREAL_EDITOR_WEBUI_ROOT"].value, "{root}/Plugins/UnrealEditorWebUI")

    def test_lock_and_archive_generation_are_deterministic(self) -> None:
        duplicate = rez_payload.create_lock(self.core_archives, self.pack_archives)
        self.assertEqual(rez_payload.canonical_json_bytes(duplicate), self.lock_bytes)
        loaded = rez_payload.load_lock(self.lock_path, self.lock_sha)
        self.assertEqual(loaded, self.lock)
        self.assertEqual([item["variantId"] for item in loaded["core"]], ["ue54", "ue55", "ue58"])

    def test_downloaded_artifact_root_is_rewritten_and_real_uat_manifest_is_required(self) -> None:
        downloaded = self.root / "UnrealEditorWebUI-Package-UE54-Win64"
        shutil.copytree(self.root / "core-source/ue54/UnrealEditorWebUI", downloaded)
        output = self.root / "rewritten-root.zip"
        rez_payload.create_deterministic_archive(
            downloaded,
            output,
            archive_root_name="UnrealEditorWebUI",
        )
        with zipfile.ZipFile(output) as archive:
            self.assertTrue(
                all(name.startswith("UnrealEditorWebUI/") for name in archive.namelist())
            )
        rez_payload._inspect_archive(
            output,
            "UnrealEditorWebUI",
            variant=self.variants[0],
            pack_identity=None,
        )
        manifest = downloaded / "Binaries/Win64/UnrealEditor.modules"
        manifest.rename(manifest.with_name("UnrealEditorWebUI.modules"))
        wrong = self.root / "wrong-manifest.zip"
        rez_payload.create_deterministic_archive(
            downloaded,
            wrong,
            archive_root_name="UnrealEditorWebUI",
        )
        with self.assertRaisesRegex(rez_payload.RezPayloadError, "canonical module manifest"):
            rez_payload._inspect_archive(
                wrong,
                "UnrealEditorWebUI",
                variant=self.variants[0],
                pack_identity=None,
            )

    def test_installs_all_variants_and_prunes_core_build_inputs(self) -> None:
        for index, variant in enumerate(self.variants):
            destination = self.root / "variants" / variant["id"]
            receipt = rez_payload.install_locked_payload(
                self.lock,
                self.payloads,
                destination,
                kind="core",
                recipe="unreal_editor_webui",
                variant_index=index,
            )
            self.assertEqual(receipt["variantId"], variant["id"])
            plugin = destination / "Plugins/UnrealEditorWebUI"
            self.assertFalse((plugin / "Source").exists())
            self.assertFalse((plugin / "Intermediate").exists())
            self.assertTrue((plugin / "Binaries/Win64/UnrealEditor-UnrealEditorWebUI.dll").is_file())
            self.assertTrue((destination / "Scripts/uewebui-rez-verify.cmd").is_file())
            self.assertEqual(rez_payload.verify_installed(destination)["variantId"], variant["id"])

    def test_installed_verification_is_read_only_and_rejects_restored_source(self) -> None:
        core, asset, level = self._install_all()
        packages = {
            "unreal_editor_webui": core,
            "unreal_editor_webui_asset_tools": asset,
            "unreal_editor_webui_level_tools": level,
        }
        self.assertEqual(
            rez_payload.RESOLVED_PACKAGE_ENV,
            {
                "unreal_editor_webui": "REZ_UNREAL_EDITOR_WEBUI_ROOT",
                "unreal_editor_webui_asset_tools": "REZ_UNREAL_EDITOR_WEBUI_ASSET_TOOLS_ROOT",
                "unreal_editor_webui_level_tools": "REZ_UNREAL_EDITOR_WEBUI_LEVEL_TOOLS_ROOT",
            },
        )
        for package, package_root in packages.items():
            environment_name = rez_payload.RESOLVED_PACKAGE_ENV[package]
            with mock.patch.dict(
                os.environ, {environment_name: str(package_root)}, clear=True
            ):
                self.assertEqual(
                    rez_payload.verify_resolved(package)["packageName"], package
                )

        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(rez_payload.RezPayloadError, "environment is missing"):
                rez_payload.verify_resolved("unreal_editor_webui")
        with mock.patch.dict(
            os.environ,
            {"REZ_UNREAL_EDITOR_WEBUI_ASSET_TOOLS_ROOT": str(core)},
            clear=True,
        ):
            with self.assertRaisesRegex(rez_payload.RezPayloadError, "another recipe"):
                rez_payload.verify_resolved("unreal_editor_webui_asset_tools")
        with self.assertRaisesRegex(rez_payload.RezPayloadError, "closed recipe set"):
            rez_payload.verify_resolved("unreal_editor_webui_project")

        restored = core / "Plugins/UnrealEditorWebUI/Source/Injected/private.cpp"
        restored.parent.mkdir(parents=True)
        restored.write_text("unexpected build input\n", encoding="utf-8")
        with self.assertRaisesRegex(rez_payload.RezPayloadError, "modified"):
            rez_payload.verify_installed(core)
        self.assertTrue(restored.is_file(), "read-only verification must not repair tampering")

    def test_tool_pack_installs_require_packager_manifest_and_final_tree(self) -> None:
        _, asset, level = self._install_all()
        self.assertEqual(rez_payload.verify_installed(asset)["packId"], "com.openai.fixture.asset-tools")
        self.assertEqual(rez_payload.verify_installed(level)["packId"], "com.openai.fixture.level-tools")
        commands = asset / "Plugins/AssetToolsFixture/Content/Python/ue_webui_asset_tools_fixture/commands.py"
        commands.write_text(commands.read_text() + "# tamper\n", encoding="utf-8")
        with self.assertRaisesRegex(rez_payload.RezPayloadError, "modified"):
            rez_payload.verify_installed(asset)

    def test_bad_archive_lock_and_wrong_variant_fail_closed(self) -> None:
        bad_hash = copy.deepcopy(self.lock)
        bad_hash["core"][0]["archiveSha256"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(rez_payload.RezPayloadError, "does not match"):
            rez_payload.install_locked_payload(
                bad_hash,
                self.payloads,
                self.root / "bad-hash",
                kind="core",
                recipe="unreal_editor_webui",
                variant_index=0,
            )
        wrong_variant = copy.deepcopy(self.lock)
        for field in ("archiveFile", "archiveSha256", "finalTreeSha256"):
            wrong_variant["core"][1][field] = wrong_variant["core"][0][field]
        with self.assertRaisesRegex(rez_payload.RezPayloadError, "locked UE variant"):
            rez_payload.install_locked_payload(
                wrong_variant,
                self.payloads,
                self.root / "wrong-variant",
                kind="core",
                recipe="unreal_editor_webui",
                variant_index=1,
            )
        bad_tree = copy.deepcopy(self.lock)
        bad_tree["core"][0]["finalTreeSha256"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(rez_payload.RezPayloadError, "Final activated"):
            rez_payload.install_locked_payload(
                bad_tree,
                self.payloads,
                self.root / "bad-tree",
                kind="core",
                recipe="unreal_editor_webui",
                variant_index=0,
            )
        duplicate_name = copy.deepcopy(self.lock)
        duplicate_name["toolPacks"][0]["archiveFile"] = duplicate_name["core"][0]["archiveFile"]
        with self.assertRaisesRegex(rez_payload.RezPayloadError, "globally unique"):
            rez_payload.validate_lock(duplicate_name)

    def test_external_preflight_accepts_two_or_one_pack_and_rejects_duplicate_core(self) -> None:
        core, asset, level = self._install_all()
        engine = _engine_root(self.root / "UE_5.4", self.variants[0])
        project_root = self.root / "project"
        project_root.mkdir()
        project = _project(project_root)
        roots = os.pathsep.join(str(path / "Plugins") for path in (core, asset, level))
        result = rez_payload.preflight(project, engine, roots)
        self.assertEqual(result["variantId"], "ue54")
        self.assertEqual(
            result["packIds"],
            ["com.openai.fixture.asset-tools", "com.openai.fixture.level-tools"],
        )
        one_pack = os.pathsep.join(str(path / "Plugins") for path in (core, asset))
        self.assertEqual(
            rez_payload.preflight(project, engine, one_pack)["packIds"],
            ["com.openai.fixture.asset-tools"],
        )
        aliased = os.pathsep.join((one_pack, str(core / "Plugins")))
        self.assertEqual(
            rez_payload.preflight(project, engine, aliased)["packIds"],
            ["com.openai.fixture.asset-tools"],
        )
        project_plugins = project_root / "Plugins"
        project_plugins.mkdir()
        shutil.copytree(core / "Plugins/UnrealEditorWebUI", project_plugins / "UnrealEditorWebUI")
        with self.assertRaisesRegex(rez_payload.RezPayloadError, "core_duplicate"):
            rez_payload.preflight(project, engine, roots)

    def test_engine_editor_identity_and_wrong_editor_fail_before_spawn(self) -> None:
        core, asset, _ = self._install_all()
        engine = _engine_root(self.root / "UE_5.4", self.variants[0])
        project_root = self.root / "project-editor"
        project_root.mkdir()
        project = _project(project_root)
        roots = os.pathsep.join(str(path / "Plugins") for path in (core, asset))
        os.environ["UE_ADDITIONAL_PLUGIN_PATHS"] = roots
        self.addCleanup(os.environ.pop, "UE_ADDITIONAL_PLUGIN_PATHS", None)
        wrong_editor = self.root / "outside-editor.exe"
        wrong_editor.write_bytes(b"not launched")
        with self.assertRaisesRegex(rez_payload.RezPayloadError, "Requested Unreal Editor"):
            rez_payload.launch(project, engine, wrong_editor, [])

        editor_version = engine / "Engine/Binaries/Win64/UnrealEditor.version"
        identity = json.loads(editor_version.read_text(encoding="utf-8"))
        identity["Changelist"] += 1
        _write_json(editor_version, identity)
        with self.assertRaisesRegex(rez_payload.RezPayloadError, "not one exact locked"):
            rez_payload.preflight(project, engine, roots)

    def test_reparse_semicolon_and_malicious_zip_inputs_fail_closed(self) -> None:
        bad_zip = self.root / "bad-traversal.zip"
        with zipfile.ZipFile(bad_zip, "w") as archive:
            archive.writestr("UnrealEditorWebUI/../escape.txt", b"escape")
        destination = self.root / "bad-extract"
        with self.assertRaises(rez_payload.RezPayloadError):
            rez_payload._safe_extract(bad_zip, destination, "UnrealEditorWebUI")
        self.assertFalse(destination.exists())

        semicolon_root = self.root / "payload;ambiguous"
        semicolon_root.mkdir()
        with self.assertRaisesRegex(rez_payload.RezPayloadError, "semicolon"):
            rez_payload.install_locked_payload(
                self.lock,
                semicolon_root,
                self.root / "semicolon-output",
                kind="core",
                recipe="unreal_editor_webui",
                variant_index=0,
            )

        link_name = self.payloads / "linked-core.zip"
        try:
            os.symlink(self.core_archives["ue54"], link_name)
        except OSError:
            return
        linked_core_specs = dict(self.core_archives)
        linked_core_specs["ue54"] = link_name
        with self.assertRaises(rez_payload.RezPayloadError):
            rez_payload.create_lock(linked_core_specs, self.pack_archives)
        linked_lock = copy.deepcopy(self.lock)
        linked_lock["core"][0]["archiveFile"] = link_name.name
        with self.assertRaises(rez_payload.RezPayloadError):
            rez_payload.install_locked_payload(
                linked_lock,
                self.payloads,
                self.root / "linked-output",
                kind="core",
                recipe="unreal_editor_webui",
                variant_index=0,
            )

    def test_mandatory_launcher_fails_before_editor_on_tamper(self) -> None:
        core, asset, _ = self._install_all()
        engine = _engine_root(self.root / "UE_5.4", self.variants[0])
        project_root = self.root / "project-launch"
        project_root.mkdir()
        project = _project(project_root)
        roots = os.pathsep.join(str(path / "Plugins") for path in (core, asset))
        os.environ["UE_ADDITIONAL_PLUGIN_PATHS"] = roots
        self.addCleanup(os.environ.pop, "UE_ADDITIONAL_PLUGIN_PATHS", None)
        dll = core / "Plugins/UnrealEditorWebUI/Binaries/Win64/UnrealEditor-UnrealEditorWebUI.dll"
        dll.write_bytes(b"tampered")
        sentinel = self.root / "editor-ran"
        editor = self.root / "fake-editor.exe"
        editor.write_text("not executable", encoding="utf-8")
        with self.assertRaisesRegex(rez_payload.RezPayloadError, "modified"):
            rez_payload.launch(project, engine, editor, [str(sentinel)])
        self.assertFalse(sentinel.exists())

    def test_external_host_and_workflow_are_closed_contracts(self) -> None:
        script_path = SCRIPTS_ROOT / "create-rez-host-project.py"
        spec = importlib.util.spec_from_file_location("create_rez_host_project", script_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        project = module.create_project(self.root / "external-host", "5.4")
        document = json.loads(project.read_text(encoding="utf-8"))
        self.assertFalse((project.parent / "Plugins").exists())
        by_name = {item["Name"]: item for item in document["Plugins"]}
        self.assertTrue(by_name["UnrealEditorWebUI"]["Enabled"])
        self.assertNotIn("Optional", by_name["UnrealEditorWebUI"])
        for name in ("AssetToolsFixture", "LevelToolsFixture"):
            self.assertEqual(by_name[name], {"Enabled": True, "Name": name, "Optional": True})

        smoke = (SCRIPTS_ROOT / "validate-rez-external-smoke.py").read_text(encoding="utf-8")
        for contract in (
            "PluginBlueprintLibrary",
            "get_plugin_base_dir",
            '"system.ping"',
            '"system.toolPacks"',
            '"fixture.asset.echo"',
            '"fixture.level.echo"',
            '"unknown_command"',
            "sys.modules",
            "sys.path",
        ):
            self.assertIn(contract, smoke)
        self.assertIn(
            '''if any(
            isinstance(item, dict) and item.get("pluginName") == plugin_name
            for item in statuses
        ):''',
            smoke,
        )

        workflow = (REPOSITORY_ROOT / ".github/workflows/ue-ci.yml").read_text(encoding="utf-8")
        validate_lock = workflow.index("Validate repository tooling dependency sources")
        install_root = workflow.index("Install repository tooling dependencies")
        contracts = workflow.index("Validate UE build-environment evidence tooling")
        self.assertLess(validate_lock, install_root)
        self.assertLess(install_root, contracts)
        self.assertIn("rez-external-e2e:", workflow)
        self.assertIn("max-parallel: 1", workflow[workflow.index("rez-external-e2e:"):])
        self.assertIn("create-rez-host-project.py", workflow)
        self.assertEqual(workflow.count("$Launcher launch"), 2)
        self.assertIn("one-pack-after-restart", workflow)
        self.assertIn("Project/Plugins", workflow)


if __name__ == "__main__":
    unittest.main()
