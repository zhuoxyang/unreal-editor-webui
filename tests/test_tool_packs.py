from __future__ import annotations

import importlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON_DIR = REPO_ROOT / "Python"
REGISTRY_PATH = PYTHON_DIR / "unreal_editor_webui_registry.py"


def make_unreal_stub() -> types.SimpleNamespace:
    logs: list[str] = []
    error_logs: list[str] = []
    unreal = types.SimpleNamespace(
        log=logs.append,
        log_error=error_logs.append,
        SystemLibrary=types.SimpleNamespace(get_project_name=lambda: "ToolPackTestProject"),
        Paths=types.SimpleNamespace(project_dir=lambda: "/ToolPackTestProject/"),
        EditorUtilityLibrary=types.SimpleNamespace(get_selected_assets=lambda: []),
        AssetRegistryHelpers=types.SimpleNamespace(
            get_asset_registry=lambda: types.SimpleNamespace(
                get_assets_by_path=lambda path, recursive: []
            )
        ),
    )
    unreal.logs = logs
    unreal.error_logs = error_logs
    return unreal


def load_runtime():
    unreal = make_unreal_stub()
    sys.modules["unreal"] = unreal
    python_dir = str(PYTHON_DIR)
    if python_dir not in sys.path:
        sys.path.insert(0, python_dir)

    for module_name in list(sys.modules):
        if (
            module_name
            in {
                "unreal_editor_webui_registry",
                "unreal_editor_webui_sdk",
                "unreal_editor_webui_toolpacks",
                "unreal_editor_webui_write",
            }
            or module_name.startswith("unreal_editor_webui_commands")
        ):
            sys.modules.pop(module_name, None)

    importlib.invalidate_caches()
    spec = importlib.util.spec_from_file_location(
        "unreal_editor_webui_registry", REGISTRY_PATH
    )
    registry = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["unreal_editor_webui_registry"] = registry
    spec.loader.exec_module(registry)

    sdk = importlib.import_module("unreal_editor_webui_sdk")
    toolpacks = importlib.import_module("unreal_editor_webui_toolpacks")
    return registry, sdk, toolpacks, unreal


def request(command: str, payload: dict[str, object] | None = None) -> str:
    return json.dumps(
        {
            "id": "tool-pack-test",
            "command": command,
            "payload": payload or {},
        }
    )


class FakePluginBlueprintLibrary:
    def __init__(
        self,
        *,
        enabled_names: list[str],
        mounted_names: set[str],
        base_directories: dict[str, pathlib.Path],
        versions: dict[str, str],
    ) -> None:
        self.enabled_names = enabled_names
        self.mounted_names = mounted_names
        self.base_directories = base_directories
        self.versions = versions
        self.mounted_calls: list[str] = []
        self.base_directory_calls: list[str] = []
        self.version_calls: list[str] = []

    def get_enabled_plugin_names(self) -> list[str]:
        return list(self.enabled_names)

    def is_plugin_mounted(self, plugin_name: str) -> bool:
        self.mounted_calls.append(plugin_name)
        return plugin_name in self.mounted_names

    def get_plugin_base_dir(self, plugin_name: str) -> str:
        self.base_directory_calls.append(plugin_name)
        return str(self.base_directories[plugin_name])

    def get_plugin_version_name(self, plugin_name: str) -> str:
        self.version_calls.append(plugin_name)
        return self.versions[plugin_name]


class ToolPackContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry, self.sdk, self.toolpacks, self.unreal = load_runtime()
        self.temp_directory = tempfile.TemporaryDirectory()
        self.temp_root = pathlib.Path(self.temp_directory.name)
        self.package_names: set[str] = set()

    def tearDown(self) -> None:
        for module_name in list(sys.modules):
            if any(
                module_name == package_name
                or module_name.startswith(f"{package_name}.")
                for package_name in self.package_names
            ):
                sys.modules.pop(module_name, None)

        temp_root = self.temp_root.resolve()
        retained_paths: list[str] = []
        for entry in sys.path:
            try:
                pathlib.Path(entry).resolve().relative_to(temp_root)
            except (OSError, ValueError):
                retained_paths.append(entry)
        sys.path[:] = retained_paths
        self.temp_directory.cleanup()

    def create_pack(
        self,
        *,
        plugin_name: str,
        pack_id: str,
        python_package: str,
        command_namespace: str,
        source: str,
        required_core_api: int | None = None,
    ):
        python_root = self.temp_root / plugin_name / "Content" / "Python"
        package_parts = python_package.split(".")
        package_directory = python_root
        for index, package_part in enumerate(package_parts):
            package_directory /= package_part
            package_directory.mkdir(parents=True, exist_ok=True)
            init_path = package_directory / "__init__.py"
            init_path.write_text(
                source if index == len(package_parts) - 1 else "",
                encoding="utf-8",
            )

        for index in range(1, len(package_parts) + 1):
            self.package_names.add(".".join(package_parts[:index]))

        return self.toolpacks.ToolPackDescriptor(
            plugin_name=plugin_name,
            plugin_version="1.0.0",
            pack_id=pack_id,
            required_core_api=(
                self.sdk.SDK_API_VERSION
                if required_core_api is None
                else required_core_api
            ),
            python_package=python_package,
            command_namespace=command_namespace,
            python_root=python_root,
        )

    def execute(self, command: str, payload: dict[str, object] | None = None):
        return json.loads(self.registry.execute_command(request(command, payload)))

    def diagnostics(self) -> list[dict[str, str]]:
        return list(self.registry.COMMAND_LOAD_ERRORS)

    def tool_pack_status(self) -> dict[str, object]:
        response = self.execute("system.toolPacks")
        self.assertTrue(response["ok"])
        return response["result"]

    def test_two_healthy_packs_share_the_sdk_registry_and_load_in_stable_order(self):
        alpha = self.create_pack(
            plugin_name="AlphaPlugin",
            pack_id="com.example.alpha",
            python_package="alpha_tool_pack",
            command_namespace="alpha",
            source=(
                "from unreal_editor_webui_sdk import SDK_API_VERSION, CommandExecutionError, command\n"
                "\n"
                "@command('alpha.echo')\n"
                "def echo(payload):\n"
                "    return {'source': 'sdk', 'apiVersion': SDK_API_VERSION, 'payload': payload}\n"
                "\n"
                "@command('alpha.fail')\n"
                "def fail(payload):\n"
                "    raise CommandExecutionError('alpha_failed', 'Alpha failed safely.')\n"
            ),
        )
        beta = self.create_pack(
            plugin_name="BetaPlugin",
            pack_id="com.example.beta",
            python_package="beta_tool_pack",
            command_namespace="beta",
            source=(
                "from unreal_editor_webui_registry import command\n"
                "\n"
                "@command('beta.echo')\n"
                "def echo(payload):\n"
                "    return {'source': 'legacy', 'payload': payload}\n"
            ),
        )

        self.assertNotIn(str(alpha.python_root), sys.path)
        self.assertNotIn(str(beta.python_root), sys.path)
        self.registry.load_tool_packs([beta, alpha], [])

        self.assertEqual(self.diagnostics(), [])
        self.assertIn("alpha.echo", self.registry.COMMANDS)
        self.assertIn("alpha.fail", self.registry.COMMANDS)
        self.assertIn("beta.echo", self.registry.COMMANDS)
        external_registration_order = [
            name
            for name in self.registry.COMMANDS
            if name in {"alpha.echo", "alpha.fail", "beta.echo"}
        ]
        self.assertEqual(
            external_registration_order,
            ["alpha.echo", "alpha.fail", "beta.echo"],
        )

        alpha_result = self.execute("alpha.echo", {"value": 7})
        beta_result = self.execute("beta.echo", {"value": 8})
        failure = self.execute("alpha.fail")
        self.assertTrue(alpha_result["ok"])
        self.assertEqual(alpha_result["result"]["source"], "sdk")
        self.assertEqual(
            alpha_result["result"]["apiVersion"], self.sdk.SDK_API_VERSION
        )
        self.assertEqual(alpha_result["result"]["payload"], {"value": 7})
        self.assertTrue(beta_result["ok"])
        self.assertEqual(beta_result["result"]["source"], "legacy")
        self.assertEqual(beta_result["result"]["payload"], {"value": 8})
        self.assertFalse(failure["ok"])
        self.assertEqual(failure["error"]["code"], "alpha_failed")
        self.assertIs(
            self.sdk.CommandExecutionError,
            self.registry.CommandExecutionError,
        )
        status = self.tool_pack_status()
        self.assertEqual(status["statusVersion"], 1)
        self.assertEqual(status["coreApiVersion"], self.sdk.SDK_API_VERSION)
        self.assertEqual(status["truncatedCount"], 0)
        self.assertEqual(
            status["packs"],
            [
                {
                    "provider": "com.example.alpha",
                    "packId": "com.example.alpha",
                    "pluginName": "AlphaPlugin",
                    "pluginVersion": "1.0.0",
                    "requiredCoreApi": self.sdk.SDK_API_VERSION,
                    "state": "loaded",
                    "commandCount": 2,
                    "commands": ["alpha.echo", "alpha.fail"],
                },
                {
                    "provider": "com.example.beta",
                    "packId": "com.example.beta",
                    "pluginName": "BetaPlugin",
                    "pluginVersion": "1.0.0",
                    "requiredCoreApi": self.sdk.SDK_API_VERSION,
                    "state": "loaded",
                    "commandCount": 1,
                    "commands": ["beta.echo"],
                },
            ],
        )
        rendered_status = json.dumps(status, ensure_ascii=False)
        self.assertNotIn(str(alpha.python_root), rendered_status)
        self.assertNotIn(str(beta.python_root), rendered_status)
        self.assertTrue(
            all(
                set(pack)
                == {
                    "provider",
                    "packId",
                    "pluginName",
                    "pluginVersion",
                    "requiredCoreApi",
                    "state",
                    "commandCount",
                    "commands",
                }
                for pack in status["packs"]
            )
        )
        self.assertTrue(
            all(pack["commandCount"] == len(pack["commands"]) for pack in status["packs"])
        )

    def test_repeat_load_uses_authoritative_fingerprint_and_rejects_same_id_spoof(self):
        original = self.create_pack(
            plugin_name="OriginalPlugin",
            pack_id="com.example.authoritative",
            python_package="authoritative_pack",
            command_namespace="authoritative",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('authoritative.echo')\n"
                "def echo(payload): return {'loaded': True}\n"
            ),
        )
        self.registry.load_tool_packs([original], [])
        authoritative_fingerprint = self.registry._LOADED_TOOL_PACK_FINGERPRINTS[
            original.pack_id
        ]
        spoof = self.toolpacks.ToolPackDescriptor(
            plugin_name="SpoofPlugin",
            plugin_version="9.9.9",
            pack_id=original.pack_id,
            required_core_api=self.sdk.SDK_API_VERSION + 99,
            python_package="missing_spoof_pack",
            command_namespace="spoof",
            python_root=self.temp_root / "missing-spoof-root",
        )

        self.registry.load_tool_packs([spoof], [])

        self.assertIn("authoritative.echo", self.registry.COMMANDS)
        self.assertNotIn("spoof.echo", self.registry.COMMANDS)
        self.assertEqual(
            self.registry._LOADED_TOOL_PACK_FINGERPRINTS[original.pack_id],
            authoritative_fingerprint,
        )
        status_by_plugin = {
            pack["pluginName"]: pack for pack in self.tool_pack_status()["packs"]
        }
        self.assertEqual(status_by_plugin["OriginalPlugin"]["state"], "loaded")
        self.assertEqual(
            status_by_plugin["OriginalPlugin"]["commands"],
            ["authoritative.echo"],
        )
        self.assertEqual(status_by_plugin["SpoofPlugin"]["state"], "rejected")
        self.assertEqual(status_by_plugin["SpoofPlugin"]["commands"], [])
        self.assertIn("different descriptor", self.diagnostics()[0]["error"])

        diagnostics_before = list(self.diagnostics())
        self.registry.load_tool_packs([original], [])
        self.assertEqual(self.diagnostics(), diagnostics_before)
        self.assertEqual(
            {
                pack["pluginName"]: pack["state"]
                for pack in self.tool_pack_status()["packs"]
            },
            {"OriginalPlugin": "loaded", "SpoofPlugin": "rejected"},
        )

    def test_incremental_load_rejects_namespace_overlap_with_loaded_pack_only(self):
        parent = self.create_pack(
            plugin_name="LoadedParentPlugin",
            pack_id="com.example.loaded-parent",
            python_package="loaded_parent_pack",
            command_namespace="studio.assets",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('studio.assets.scan')\n"
                "def scan(payload): return {'loaded': True}\n"
            ),
        )
        child = self.create_pack(
            plugin_name="IncrementalChildPlugin",
            pack_id="com.example.incremental-child",
            python_package="incremental_child_pack",
            command_namespace="studio.assets.validate",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('studio.assets.validate.run')\n"
                "def run(payload): return {'loaded': True}\n"
            ),
        )
        package_conflict = self.create_pack(
            plugin_name="IncrementalPackageConflictPlugin",
            pack_id="com.example.incremental-package-conflict",
            python_package="loaded_parent_pack.child",
            command_namespace="studio.other",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('studio.other.run')\n"
                "def run(payload): return {'loaded': True}\n"
            ),
        )

        self.registry.load_tool_packs([parent], [])
        self.registry.load_tool_packs([child], [])
        self.registry.load_tool_packs([package_conflict], [])

        self.assertIn("studio.assets.scan", self.registry.COMMANDS)
        self.assertNotIn("studio.assets.validate.run", self.registry.COMMANDS)
        self.assertNotIn("studio.other.run", self.registry.COMMANDS)
        self.assertIn(parent.pack_id, self.registry._LOADED_TOOL_PACK_FINGERPRINTS)
        self.assertNotIn(child.pack_id, self.registry._LOADED_TOOL_PACK_FINGERPRINTS)
        self.assertNotIn(
            package_conflict.pack_id,
            self.registry._LOADED_TOOL_PACK_FINGERPRINTS,
        )
        self.assertTrue(any("overlaps" in item["error"] for item in self.diagnostics()))
        self.assertTrue(any("top-level" in item["error"] for item in self.diagnostics()))
        status_by_id = {
            pack["packId"]: pack for pack in self.tool_pack_status()["packs"]
        }
        self.assertEqual(status_by_id[parent.pack_id]["state"], "loaded")
        self.assertEqual(
            status_by_id[parent.pack_id]["commands"],
            ["studio.assets.scan"],
        )
        self.assertEqual(status_by_id[child.pack_id]["state"], "rejected")
        self.assertEqual(status_by_id[child.pack_id]["commands"], [])
        self.assertEqual(status_by_id[package_conflict.pack_id]["state"], "rejected")
        self.assertEqual(status_by_id[package_conflict.pack_id]["commands"], [])

    def test_successful_pack_restores_sys_path_side_effects_and_keeps_managed_root(self):
        preexisting_path = str(self.temp_root / "preexisting-sys-path")
        injected_path = str(self.temp_root / "pack-injected-sys-path")
        sys.path.append(preexisting_path)
        pack = self.create_pack(
            plugin_name="SysPathPlugin",
            pack_id="com.example.sys-path",
            python_package="sys_path_tool_pack",
            command_namespace="syspath",
            source=(
                "import sys\n"
                "from unreal_editor_webui_sdk import command\n"
                f"sys.path.remove({preexisting_path!r})\n"
                f"sys.path.append({injected_path!r})\n"
                "\n"
                "@command('syspath.echo')\n"
                "def echo(payload):\n"
                "    return {'loaded': True}\n"
            ),
        )

        self.registry.load_tool_packs([pack], [])

        managed_root = str(pack.python_root.resolve())
        self.assertIn("syspath.echo", self.registry.COMMANDS)
        self.assertEqual(self.diagnostics(), [])
        self.assertIn(preexisting_path, sys.path)
        self.assertNotIn(injected_path, sys.path)
        self.assertEqual(sys.path.count(managed_root), 1)
        self.assertLess(sys.path.index(str(PYTHON_DIR)), sys.path.index(managed_root))

    def test_shadowed_entry_package_is_rejected_before_foreign_code_executes(self):
        shadow_marker = self.temp_root / "shadow-entry-executed.txt"
        shadow_root = self.temp_root / "shadow-python-root"
        shadow_package = shadow_root / "origin_guard_tool_pack"
        shadow_package.mkdir(parents=True)
        (shadow_package / "__init__.py").write_text(
            "from pathlib import Path\n"
            f"Path({str(shadow_marker)!r}).write_text('executed', encoding='utf-8')\n",
            encoding="utf-8",
        )
        pack = self.create_pack(
            plugin_name="OriginGuardPlugin",
            pack_id="com.example.origin-guard",
            python_package="origin_guard_tool_pack",
            command_namespace="originguard",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('originguard.echo')\n"
                "def echo(payload): return {'origin': 'tool-pack'}\n"
            ),
        )

        sys.path.insert(0, str(shadow_root))
        self.registry.load_tool_packs([pack], [])

        self.assertFalse(shadow_marker.exists())
        self.assertNotIn("originguard.echo", self.registry.COMMANDS)
        self.assertNotIn("origin_guard_tool_pack", sys.modules)
        self.assertEqual(
            [item["module"] for item in self.diagnostics()],
            ["toolpack:com.example.origin-guard"],
        )

    def test_scoped_meta_path_guard_bypasses_foreign_finder_for_declared_package(self):
        foreign_marker = self.temp_root / "foreign-finder-executed.txt"
        expected_marker = self.temp_root / "expected-package-executed.txt"
        pack = self.create_pack(
            plugin_name="MetaPathGuardPlugin",
            pack_id="com.example.meta-path-guard",
            python_package="meta_path_guard_tool_pack",
            command_namespace="metapathguard",
            source=(
                "from pathlib import Path\n"
                "from unreal_editor_webui_sdk import command\n"
                f"Path({str(expected_marker)!r}).write_text('expected', encoding='utf-8')\n"
                "@command('metapathguard.expected')\n"
                "def expected(payload): return {'origin': 'tool-pack'}\n"
            ),
        )

        class ForeignLoader:
            def create_module(self, spec):
                return None

            def exec_module(self, module):
                foreign_marker.write_text("foreign", encoding="utf-8")
                module.__file__ = str(
                    pack.python_root
                    / pack.python_package
                    / "__init__.py"
                )
                module.__path__ = [str(pack.python_root / pack.python_package)]
                self.registry.command("metapathguard.injected")(
                    lambda payload: {"origin": "foreign-finder"}
                )

            def __init__(self, registry):
                self.registry = registry

        class ForeignFinder:
            def find_spec(finder_self, fullname, path=None, target=None):
                del path, target
                if fullname != pack.python_package:
                    return None
                return importlib.util.spec_from_loader(
                    fullname,
                    ForeignLoader(self.registry),
                    is_package=True,
                )

        finder = ForeignFinder()
        sys.meta_path.insert(0, finder)
        meta_path_before = list(sys.meta_path)
        try:
            self.registry.load_tool_packs([pack], [])
        finally:
            if finder in sys.meta_path:
                sys.meta_path.remove(finder)

        self.assertTrue(expected_marker.exists())
        self.assertFalse(foreign_marker.exists())
        self.assertIn("metapathguard.expected", self.registry.COMMANDS)
        self.assertNotIn("metapathguard.injected", self.registry.COMMANDS)
        self.assertEqual(self.diagnostics(), [])
        self.assertEqual(meta_path_before, [finder, *sys.meta_path])

    def test_package_path_escape_is_rejected_before_external_submodule_executes(self):
        escape_marker = self.temp_root / "escaped-submodule-executed.txt"
        external_package_path = self.temp_root / "external-package-path"
        external_package_path.mkdir()
        (external_package_path / "escaped_commands.py").write_text(
            "from pathlib import Path\n"
            "from unreal_editor_webui_sdk import command\n"
            f"Path({str(escape_marker)!r}).write_text('executed', encoding='utf-8')\n"
            "@command('pathescape.external')\n"
            "def external(payload): return {'origin': 'external'}\n",
            encoding="utf-8",
        )
        pack = self.create_pack(
            plugin_name="PackagePathEscapePlugin",
            pack_id="com.example.package-path-escape",
            python_package="package_path_escape_tool_pack",
            command_namespace="pathescape",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                f"__path__.append({str(external_package_path)!r})\n"
                "@command('pathescape.root')\n"
                "def root(payload): return {'origin': 'root'}\n"
            ),
        )

        self.registry.load_tool_packs([pack], [])

        self.assertFalse(escape_marker.exists())
        self.assertNotIn("pathescape.root", self.registry.COMMANDS)
        self.assertNotIn("pathescape.external", self.registry.COMMANDS)
        self.assertNotIn("package_path_escape_tool_pack", sys.modules)
        self.assertEqual(
            [item["module"] for item in self.diagnostics()],
            ["toolpack:com.example.package-path-escape"],
        )

    def test_sdk_preimport_cannot_register_commands_as_core(self):
        pack = self.create_pack(
            plugin_name="PreimportGuardPlugin",
            pack_id="com.example.preimport-guard",
            python_package="preimport_guard_tool_pack",
            command_namespace="preimportguard",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('preimportguard.echo')\n"
                "def echo(payload): return {'loaded': True}\n"
            ),
        )

        sys.path.insert(0, str(pack.python_root))
        try:
            with self.assertRaises(Exception):
                importlib.import_module(pack.python_package)
        finally:
            sys.path.remove(str(pack.python_root))

        self.assertNotIn("preimportguard.echo", self.registry.COMMANDS)
        self.assertNotIn(pack.python_package, sys.modules)

        self.registry.load_tool_packs([pack], [])

        self.assertIn("preimportguard.echo", self.registry.COMMANDS)
        self.assertEqual(
            self.registry.COMMAND_OWNERS["preimportguard.echo"],
            pack.pack_id,
        )
        self.assertEqual(self.diagnostics(), [])

    def test_invalid_or_unbounded_metadata_rolls_back_without_blocking_healthy_packs(self):
        non_json = self.create_pack(
            plugin_name="AlphaNonJsonMetadataPlugin",
            pack_id="com.example.alpha-non-json-metadata",
            python_package="alpha_non_json_metadata_pack",
            command_namespace="nonjsonmetadata",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('nonjsonmetadata.echo', ui={'renderer': object()})\n"
                "def echo(payload): return {}\n"
            ),
        )
        uncopyable = self.create_pack(
            plugin_name="BetaUncopyableMetadataPlugin",
            pack_id="com.example.beta-uncopyable-metadata",
            python_package="beta_uncopyable_metadata_pack",
            command_namespace="uncopyablemetadata",
            source=(
                "import threading\n"
                "from unreal_editor_webui_sdk import command\n"
                "@command('uncopyablemetadata.echo', ui={'lock': threading.Lock()})\n"
                "def echo(payload): return {}\n"
            ),
        )
        oversized = self.create_pack(
            plugin_name="GammaOversizedMetadataPlugin",
            pack_id="com.example.gamma-oversized-metadata",
            python_package="gamma_oversized_metadata_pack",
            command_namespace="oversizedmetadata",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('oversizedmetadata.echo', description='x' * (4 * 1024 * 1024))\n"
                "def echo(payload): return {}\n"
            ),
        )
        too_many_commands = self.create_pack(
            plugin_name="DeltaTooManyCommandsPlugin",
            pack_id="com.example.delta-too-many-commands",
            python_package="delta_too_many_commands_pack",
            command_namespace="toomanycommands",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "for index in range(257):\n"
                "    def handler(payload, command_index=index):\n"
                "        return {'index': command_index}\n"
                "    command(f'toomanycommands.command_{index}')(handler)\n"
            ),
        )
        private_registry_mutation = self.create_pack(
            plugin_name="EpsilonPrivateRegistryMutationPlugin",
            pack_id="com.example.epsilon-private-registry-mutation",
            python_package="epsilon_private_registry_mutation_pack",
            command_namespace="privateregistrymutation",
            source=(
                "import threading\n"
                "import unreal_editor_webui_registry as registry\n"
                "from unreal_editor_webui_sdk import command\n"
                "@command('privateregistrymutation.echo')\n"
                "def echo(payload): return {}\n"
                "registry.COMMAND_METADATA['privateregistrymutation.echo'] = "
                "{'lock': threading.Lock()}\n"
            ),
        )
        healthy = self.create_pack(
            plugin_name="ZetaHealthyMetadataPlugin",
            pack_id="com.example.zeta-healthy-metadata",
            python_package="zeta_healthy_metadata_pack",
            command_namespace="healthymetadata",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('healthymetadata.echo')\n"
                "def echo(payload): return {'healthy': True}\n"
            ),
        )

        self.registry.load_tool_packs(
            [
                healthy,
                private_registry_mutation,
                too_many_commands,
                oversized,
                uncopyable,
                non_json,
            ],
            [],
        )

        rejected_commands = {
            "nonjsonmetadata.echo",
            "uncopyablemetadata.echo",
            "oversizedmetadata.echo",
            "privateregistrymutation.echo",
            "toomanycommands.command_0",
            "toomanycommands.command_256",
        }
        self.assertTrue(rejected_commands.isdisjoint(self.registry.COMMANDS))
        self.assertIn("healthymetadata.echo", self.registry.COMMANDS)
        self.assertEqual(
            [item["module"] for item in self.diagnostics()],
            [
                "toolpack:com.example.alpha-non-json-metadata",
                "toolpack:com.example.beta-uncopyable-metadata",
                "toolpack:com.example.delta-too-many-commands",
                "toolpack:com.example.epsilon-private-registry-mutation",
                "toolpack:com.example.gamma-oversized-metadata",
            ],
        )

        catalogue = self.execute("system.commands")
        self.assertTrue(catalogue["ok"])
        command_names = {
            item["name"] for item in catalogue["result"]["commands"]
        }
        self.assertIn("system.ping", command_names)
        self.assertIn("healthymetadata.echo", command_names)
        self.assertTrue(rejected_commands.isdisjoint(command_names))

    def test_metadata_is_detached_from_mutable_decorator_arguments(self):
        pack = self.create_pack(
            plugin_name="DetachedMetadataPlugin",
            pack_id="com.example.detached-metadata",
            python_package="detached_metadata_pack",
            command_namespace="detachedmetadata",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "schema = {\n"
                "    'type': 'object',\n"
                "    'properties': {'value': {'type': 'string', 'description': 'original'}},\n"
                "}\n"
                "tags = ['original-tag']\n"
                "asset_types = ['StaticMesh']\n"
                "ui = {'group': {'label': 'original-ui'}}\n"
                "warnings = ['original-warning']\n"
                "@command(\n"
                "    'detachedmetadata.echo',\n"
                "    schema=schema,\n"
                "    tags=tags,\n"
                "    supported_asset_types=asset_types,\n"
                "    ui=ui,\n"
                "    warnings=warnings,\n"
                ")\n"
                "def echo(payload): return payload\n"
                "schema['properties']['value']['description'] = 'mutated'\n"
                "tags.append('mutated-tag')\n"
                "asset_types.append('Texture2D')\n"
                "ui['group']['label'] = 'mutated-ui'\n"
                "warnings.append('mutated-warning')\n"
            ),
        )

        self.registry.load_tool_packs([pack], [])

        metadata = self.registry.COMMAND_METADATA["detachedmetadata.echo"]
        self.assertEqual(
            metadata["schema"]["properties"]["value"]["description"],
            "original",
        )
        self.assertEqual(metadata["tags"], ["original-tag"])
        self.assertEqual(metadata["supportedAssetTypes"], ["StaticMesh"])
        self.assertEqual(metadata["ui"], {"group": {"label": "original-ui"}})
        self.assertEqual(metadata["warnings"], ["original-warning"])

    def test_dotted_python_packages_with_one_top_level_fail_closed_as_a_group(self):
        alpha = self.create_pack(
            plugin_name="VendorAlphaPlugin",
            pack_id="com.example.vendor-alpha",
            python_package="vendor.alpha",
            command_namespace="vendoralpha",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('vendoralpha.echo')\n"
                "def echo(payload): return {'pack': 'alpha'}\n"
            ),
        )
        beta = self.create_pack(
            plugin_name="VendorBetaPlugin",
            pack_id="com.example.vendor-beta",
            python_package="vendor.beta",
            command_namespace="vendorbeta",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('vendorbeta.echo')\n"
                "def echo(payload): return {'pack': 'beta'}\n"
            ),
        )

        self.registry.load_tool_packs([beta, alpha], [])

        self.assertNotIn("vendoralpha.echo", self.registry.COMMANDS)
        self.assertNotIn("vendorbeta.echo", self.registry.COMMANDS)
        self.assertEqual(
            [item["module"] for item in self.diagnostics()],
            [
                "toolpack:com.example.vendor-alpha",
                "toolpack:com.example.vendor-beta",
            ],
        )
        self.assertTrue(
            all("top-level" in item["error"] for item in self.diagnostics())
        )

    def test_one_dotted_package_with_init_at_every_level_loads(self):
        pack = self.create_pack(
            plugin_name="UniqueVendorAlphaPlugin",
            pack_id="com.example.unique-vendor-alpha",
            python_package="uniquevendor.alpha",
            command_namespace="uniquevendoralpha",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('uniquevendoralpha.echo')\n"
                "def echo(payload): return {'loaded': True}\n"
            ),
        )

        self.registry.load_tool_packs([pack], [])

        self.assertIn("uniquevendoralpha.echo", self.registry.COMMANDS)
        self.assertEqual(self.diagnostics(), [])

    def test_module_and_load_error_limits_fail_closed_and_keep_catalogue_usable(self):
        marker = self.temp_root / "module-limit-root-executed.txt"
        pack = self.create_pack(
            plugin_name="ModuleLimitPlugin",
            pack_id="com.example.module-limit",
            python_package="module_limit_pack",
            command_namespace="modulelimit",
            source=(
                "from pathlib import Path\n"
                "from unreal_editor_webui_sdk import command\n"
                f"Path({str(marker)!r}).write_text('executed', encoding='utf-8')\n"
                "@command('modulelimit.echo')\n"
                "def echo(payload): return {}\n"
            ),
        )
        package_directory = pack.python_root / pack.python_package
        for index in range(self.registry.MAX_TOOL_PACK_MODULE_COUNT + 1):
            (package_directory / f"module_{index:03d}.py").write_text("", encoding="utf-8")

        self.registry.load_tool_packs([pack], [])

        self.assertFalse(marker.exists())
        self.assertNotIn("modulelimit.echo", self.registry.COMMANDS)
        self.registry.COMMAND_LOAD_ERRORS.clear()
        discovery_errors = [
            {"module": f"plugin:error-{index:03d}", "error": "rejected manifest"}
            for index in range(self.registry.MAX_TOOL_PACK_DISCOVERY_ERROR_COUNT + 20)
        ]
        self.registry.load_tool_packs([], discovery_errors)
        self.assertEqual(
            len(self.registry.COMMAND_LOAD_ERRORS),
            self.registry.MAX_COMMAND_LOAD_ERRORS,
        )
        catalogue = self.execute("system.commands")
        self.assertTrue(catalogue["ok"])
        self.assertEqual(
            len(catalogue["result"]["loadErrors"]),
            self.registry.MAX_COMMAND_LOAD_ERRORS,
        )
        status = self.tool_pack_status()
        self.assertEqual(
            len(status["packs"]),
            self.registry.MAX_TOOL_PACK_STATUS_COUNT,
        )
        self.assertEqual(status["truncatedCount"], 21)
        self.assertEqual(status["packs"][0]["packId"], "com.example.module-limit")
        self.assertTrue(
            all(pack["state"] == "rejected" for pack in status["packs"])
        )
        self.assertTrue(
            all(pack["commandCount"] == len(pack["commands"]) for pack in status["packs"])
        )

        self.registry.load_tool_packs([], [])
        self.assertEqual(self.tool_pack_status(), status)

    def test_truncated_count_accumulates_omitted_observations_and_saturates(self):
        discovery_errors = [
            {"module": f"plugin:error-{index:03d}", "error": "rejected manifest"}
            for index in range(self.registry.MAX_TOOL_PACK_DISCOVERY_ERROR_COUNT + 21)
        ]
        self.registry.load_tool_packs([], discovery_errors)

        initial_status = self.tool_pack_status()
        self.assertEqual(
            len(initial_status["packs"]),
            self.registry.MAX_TOOL_PACK_STATUS_COUNT,
        )
        self.assertEqual(initial_status["truncatedCount"], 21)

        hidden_observation = {
            "module": "plugin:zzzz-hidden",
            "error": "rejected manifest",
        }
        self.registry.load_tool_packs([], [hidden_observation])
        second_status = self.tool_pack_status()
        self.assertEqual(second_status["truncatedCount"], 22)
        self.assertNotIn(
            "zzzz-hidden",
            {pack["pluginName"] for pack in second_status["packs"]},
        )

        self.registry.load_tool_packs([], [hidden_observation])
        self.assertEqual(self.tool_pack_status()["truncatedCount"], 23)
        self.registry.load_tool_packs([], [])
        self.assertEqual(self.tool_pack_status()["truncatedCount"], 23)

        self.registry._TOOL_PACK_STATUS_META["truncatedCount"] = (
            self.registry.MAX_TOOL_PACK_TRUNCATED_COUNT - 1
        )
        self.registry.load_tool_packs([], [hidden_observation])
        self.assertEqual(
            self.tool_pack_status()["truncatedCount"],
            self.registry.MAX_TOOL_PACK_TRUNCATED_COUNT,
        )
        self.registry.load_tool_packs([], [hidden_observation])
        self.assertEqual(
            self.tool_pack_status()["truncatedCount"],
            self.registry.MAX_TOOL_PACK_TRUNCATED_COUNT,
        )

    def test_descriptor_processing_budget_bounds_conflict_work_and_status(self):
        overflow = 20
        descriptors = [
            self.toolpacks.ToolPackDescriptor(
                plugin_name=f"BudgetPlugin{index:04d}",
                plugin_version="1.0.0",
                pack_id=f"com.example.budget-{index:04d}",
                required_core_api=self.sdk.SDK_API_VERSION,
                python_package=f"budget_pack_{index:04d}",
                command_namespace=f"budget{index:04d}",
                python_root=self.temp_root / f"budget-root-{index:04d}",
            )
            for index in range(self.registry.MAX_TOOL_PACK_DESCRIPTOR_COUNT + overflow)
        ]
        attempted_ids: list[str] = []
        original_loader = self.registry._load_tool_pack_descriptor

        def reject_without_import(descriptor):
            attempted_ids.append(descriptor.pack_id)
            return {
                "module": f"toolpack:{descriptor.pack_id}",
                "error": "Fixture rejection.",
            }

        self.registry._load_tool_pack_descriptor = reject_without_import
        try:
            self.registry.load_tool_packs(list(reversed(descriptors)), [])
        finally:
            self.registry._load_tool_pack_descriptor = original_loader

        self.assertEqual(
            len(attempted_ids),
            self.registry.MAX_TOOL_PACK_DESCRIPTOR_COUNT,
        )
        self.assertEqual(attempted_ids, sorted(attempted_ids))
        status = self.tool_pack_status()
        self.assertEqual(
            len(status["packs"]),
            self.registry.MAX_TOOL_PACK_STATUS_COUNT,
        )
        self.assertEqual(status["truncatedCount"], overflow)
        self.assertTrue(
            all(
                pack["state"] == "rejected"
                and pack["commandCount"] == 0
                and pack["commands"] == []
                for pack in status["packs"]
            )
        )

        self.registry.load_tool_packs([], [])
        self.assertEqual(self.tool_pack_status(), status)

    def test_failed_pack_rolls_back_all_registry_and_module_mutations(self):
        healthy = self.create_pack(
            plugin_name="HealthyPlugin",
            pack_id="com.example.healthy",
            python_package="healthy_tool_pack",
            command_namespace="healthy",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "\n"
                "@command('healthy.echo')\n"
                "def echo(payload):\n"
                "    return {'healthy': True}\n"
            ),
        )
        original_ping = self.registry.COMMANDS["system.ping"]
        original_ping_metadata = dict(self.registry.COMMAND_METADATA["system.ping"])
        broken = self.create_pack(
            plugin_name="PrivateCanaryBrokenPlugin",
            pack_id="com.example.broken",
            python_package="broken_tool_pack",
            command_namespace="broken",
            source=(
                "import unreal_editor_webui_registry as registry\n"
                "from unreal_editor_webui_sdk import command\n"
                "\n"
                "@command('broken.partial')\n"
                "def partial(payload):\n"
                "    return {'partial': True}\n"
                "\n"
                "registry.COMMANDS.pop('system.ping')\n"
                "registry.COMMAND_METADATA.pop('system.ping')\n"
                "registry._LOADED_TOOL_PACK_FINGERPRINTS.clear()\n"
                "registry._TOOL_PACK_STATUSES.append({'pluginName': 'private-status-canary'})\n"
                "registry._TOOL_PACK_STATUS_META['truncatedCount'] = 999\n"
                "raise RuntimeError('broken import')\n"
            ),
        )
        private_path_canary = str(broken.python_root)

        self.registry.load_tool_packs([healthy, broken], [])

        self.assertIn("healthy.echo", self.registry.COMMANDS)
        self.assertIn(
            healthy.pack_id,
            self.registry._LOADED_TOOL_PACK_FINGERPRINTS,
        )
        self.assertNotIn("broken.partial", self.registry.COMMANDS)
        self.assertIs(self.registry.COMMANDS["system.ping"], original_ping)
        self.assertEqual(
            self.registry.COMMAND_METADATA["system.ping"], original_ping_metadata
        )
        self.assertNotIn("broken_tool_pack", sys.modules)
        self.assertEqual(len(self.diagnostics()), 1)
        self.assertEqual(
            self.diagnostics()[0]["module"], "toolpack:com.example.broken"
        )
        rendered_diagnostic = json.dumps(self.diagnostics(), ensure_ascii=False)
        self.assertNotIn("Traceback", rendered_diagnostic)
        self.assertNotIn(private_path_canary, rendered_diagnostic)
        status = self.tool_pack_status()
        self.assertEqual(status["truncatedCount"], 0)
        self.assertEqual(
            [(pack["packId"], pack["state"], pack["commandCount"]) for pack in status["packs"]],
            [
                ("com.example.broken", "rejected", 0),
                ("com.example.healthy", "loaded", 1),
            ],
        )
        self.assertNotIn("private-status-canary", json.dumps(status))

    def test_tool_pack_cannot_mutate_existing_public_status_state(self):
        healthy = self.create_pack(
            plugin_name="StatusHealthyPlugin",
            pack_id="com.example.status-healthy",
            python_package="status_healthy_pack",
            command_namespace="statushealthy",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('statushealthy.echo')\n"
                "def echo(payload): return {'healthy': True}\n"
            ),
        )
        tampering = self.create_pack(
            plugin_name="StatusTamperingPlugin",
            pack_id="com.example.status-tampering",
            python_package="status_tampering_pack",
            command_namespace="statustampering",
            source=(
                "import unreal_editor_webui_registry as registry\n"
                "from unreal_editor_webui_sdk import command\n"
                "@command('statustampering.echo')\n"
                "def echo(payload): return {}\n"
                "registry._LOADED_TOOL_PACK_FINGERPRINTS.clear()\n"
                "registry._TOOL_PACK_STATUSES.clear()\n"
                "registry._TOOL_PACK_STATUS_META['truncatedCount'] = 321\n"
            ),
        )

        self.registry.load_tool_packs([healthy], [])
        original_status = self.tool_pack_status()
        self.registry.load_tool_packs([tampering], [])

        self.assertIn("statushealthy.echo", self.registry.COMMANDS)
        self.assertIn(
            healthy.pack_id,
            self.registry._LOADED_TOOL_PACK_FINGERPRINTS,
        )
        self.assertNotIn("statustampering.echo", self.registry.COMMANDS)
        self.assertNotIn(tampering.python_package, sys.modules)
        status = self.tool_pack_status()
        self.assertEqual(status["truncatedCount"], 0)
        self.assertEqual(status["packs"][0], original_status["packs"][0])
        self.assertEqual(
            status["packs"][1],
            {
                "provider": "com.example.status-tampering",
                "packId": "com.example.status-tampering",
                "pluginName": "StatusTamperingPlugin",
                "pluginVersion": "1.0.0",
                "requiredCoreApi": self.sdk.SDK_API_VERSION,
                "state": "rejected",
                "commandCount": 0,
                "commands": [],
            },
        )

    def test_command_conflict_after_partial_registration_rolls_back_the_pack(self):
        existing_handler = self.registry.COMMANDS["asset.listByPath"]
        conflicting = self.create_pack(
            plugin_name="ConflictingPlugin",
            pack_id="com.example.conflicting",
            python_package="conflicting_tool_pack",
            command_namespace="asset",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "\n"
                "@command('asset.uniqueFromConflictingPack')\n"
                "def unique(payload):\n"
                "    return {'shouldNotRemain': True}\n"
                "\n"
                "@command('asset.listByPath')\n"
                "def duplicate(payload):\n"
                "    return {'shouldNotReplaceCore': True}\n"
            ),
        )

        self.registry.load_tool_packs([conflicting], [])

        self.assertIs(self.registry.COMMANDS["asset.listByPath"], existing_handler)
        self.assertNotIn("asset.uniqueFromConflictingPack", self.registry.COMMANDS)
        self.assertNotIn("conflicting_tool_pack", sys.modules)
        self.assertEqual(
            [item["module"] for item in self.diagnostics()],
            ["toolpack:com.example.conflicting"],
        )

    def test_namespace_violation_disables_the_entire_pack(self):
        invalid = self.create_pack(
            plugin_name="NamespacePlugin",
            pack_id="com.example.namespace",
            python_package="namespace_tool_pack",
            command_namespace="owned",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "\n"
                "@command('owned.partial')\n"
                "def partial(payload):\n"
                "    return {'partial': True}\n"
                "\n"
                "@command('escaped.command')\n"
                "def escaped(payload):\n"
                "    return {'escaped': True}\n"
            ),
        )

        self.registry.load_tool_packs([invalid], [])

        self.assertNotIn("owned.partial", self.registry.COMMANDS)
        self.assertNotIn("escaped.command", self.registry.COMMANDS)
        self.assertNotIn("namespace_tool_pack", sys.modules)
        self.assertEqual(len(self.diagnostics()), 1)
        self.assertEqual(
            self.diagnostics()[0]["module"], "toolpack:com.example.namespace"
        )
        self.assertIn("namespace", self.diagnostics()[0]["error"].lower())

    def test_invalid_or_oversized_command_names_roll_back_the_entire_pack(self):
        invalid_characters = self.create_pack(
            plugin_name="InvalidCommandCharactersPlugin",
            pack_id="com.example.invalid-command-characters",
            python_package="invalid_command_characters_pack",
            command_namespace="invalidcharacters",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('invalidcharacters.validFirst')\n"
                "def valid_first(payload): return {}\n"
                "@command('invalidcharacters.bad-name')\n"
                "def invalid(payload): return {}\n"
            ),
        )
        oversized_name = "oversizedcommand." + (
            "a" * self.registry.MAX_COMMAND_NAME_LENGTH
        )
        oversized = self.create_pack(
            plugin_name="OversizedCommandNamePlugin",
            pack_id="com.example.oversized-command-name",
            python_package="oversized_command_name_pack",
            command_namespace="oversizedcommand",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                f"@command({oversized_name!r})\n"
                "def oversized(payload): return {}\n"
            ),
        )

        self.registry.load_tool_packs([oversized, invalid_characters], [])

        self.assertNotIn("invalidcharacters.validFirst", self.registry.COMMANDS)
        self.assertNotIn("invalidcharacters.bad-name", self.registry.COMMANDS)
        self.assertNotIn(oversized_name, self.registry.COMMANDS)
        self.assertNotIn(invalid_characters.python_package, sys.modules)
        self.assertNotIn(oversized.python_package, sys.modules)
        self.assertEqual(
            [item["module"] for item in self.diagnostics()],
            [
                "toolpack:com.example.invalid-command-characters",
                "toolpack:com.example.oversized-command-name",
            ],
        )

    def test_command_name_at_length_limit_and_camel_case_segments_loads(self):
        command_name = "a.bC" + (
            "d" * (self.registry.MAX_COMMAND_NAME_LENGTH - 4)
        )
        pack = self.create_pack(
            plugin_name="BoundaryCommandNamePlugin",
            pack_id="com.example.boundary-command-name",
            python_package="boundary_command_name_pack",
            command_namespace="a",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                f"@command({command_name!r})\n"
                "def boundary(payload): return {'loaded': True}\n"
            ),
        )

        self.registry.load_tool_packs([pack], [])

        self.assertEqual(len(command_name), self.registry.MAX_COMMAND_NAME_LENGTH)
        self.assertIn(command_name, self.registry.COMMANDS)
        self.assertEqual(self.diagnostics(), [])

    def test_duplicate_id_package_and_namespace_fail_closed_for_every_conflict(self):
        id_a = self.create_pack(
            plugin_name="AlphaIdPlugin",
            pack_id="com.example.duplicate-id",
            python_package="id_a_pack",
            command_namespace="ida",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('ida.echo')\n"
                "def echo(payload): return {'source': 'id-a'}\n"
            ),
        )
        id_b = self.create_pack(
            plugin_name="ZetaIdPlugin",
            pack_id="com.example.duplicate-id",
            python_package="id_b_pack",
            command_namespace="idb",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('idb.echo')\n"
                "def echo(payload): return {'source': 'id-b'}\n"
            ),
        )
        package_a = self.create_pack(
            plugin_name="PackageWinnerPlugin",
            pack_id="com.example.package-a",
            python_package="shared_python_pack",
            command_namespace="packagea",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('packagea.echo')\n"
                "def echo(payload): return {'source': 'package-a'}\n"
            ),
        )
        package_b = self.create_pack(
            plugin_name="PackageLoserPlugin",
            pack_id="com.example.package-b",
            python_package="shared_python_pack",
            command_namespace="packageb",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('packageb.echo')\n"
                "def echo(payload): return {'source': 'package-b'}\n"
            ),
        )
        namespace_a = self.create_pack(
            plugin_name="NamespaceWinnerPlugin",
            pack_id="com.example.namespace-a",
            python_package="namespace_a_pack",
            command_namespace="sharednamespace",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('sharednamespace.a')\n"
                "def echo(payload): return {'source': 'namespace-a'}\n"
            ),
        )
        namespace_b = self.create_pack(
            plugin_name="NamespaceLoserPlugin",
            pack_id="com.example.namespace-b",
            python_package="namespace_b_pack",
            command_namespace="sharednamespace",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('sharednamespace.b')\n"
                "def echo(payload): return {'source': 'namespace-b'}\n"
            ),
        )

        self.registry.load_tool_packs(
            [
                namespace_b,
                package_b,
                id_b,
                namespace_a,
                package_a,
                id_a,
            ],
            [],
        )

        self.assertNotIn("ida.echo", self.registry.COMMANDS)
        self.assertNotIn("idb.echo", self.registry.COMMANDS)
        self.assertNotIn("packagea.echo", self.registry.COMMANDS)
        self.assertNotIn("packageb.echo", self.registry.COMMANDS)
        self.assertNotIn("sharednamespace.a", self.registry.COMMANDS)
        self.assertNotIn("sharednamespace.b", self.registry.COMMANDS)
        self.assertNotIn("id_a_pack", sys.modules)
        self.assertNotIn("id_b_pack", sys.modules)
        self.assertNotIn("shared_python_pack", sys.modules)
        self.assertNotIn("namespace_a_pack", sys.modules)
        self.assertNotIn("namespace_b_pack", sys.modules)
        diagnostic_modules = [item["module"] for item in self.diagnostics()]
        self.assertEqual(
            diagnostic_modules,
            sorted(diagnostic_modules, key=str.casefold),
        )
        self.assertEqual(len(diagnostic_modules), 6)
        self.assertEqual(
            diagnostic_modules.count("toolpack:com.example.duplicate-id"), 2
        )
        self.assertEqual(
            set(diagnostic_modules),
            {
                "toolpack:com.example.duplicate-id",
                "toolpack:com.example.namespace-a",
                "toolpack:com.example.namespace-b",
                "toolpack:com.example.package-a",
                "toolpack:com.example.package-b",
            },
        )
        status = self.tool_pack_status()
        self.assertEqual(len(status["packs"]), 6)
        self.assertTrue(
            all(
                pack["state"] == "rejected" and pack["commandCount"] == 0
                for pack in status["packs"]
            )
        )
        self.assertEqual(
            [pack["pluginName"] for pack in status["packs"]],
            [
                "AlphaIdPlugin",
                "ZetaIdPlugin",
                "NamespaceWinnerPlugin",
                "NamespaceLoserPlugin",
                "PackageWinnerPlugin",
                "PackageLoserPlugin",
            ],
        )

    def test_overlapping_namespace_prefixes_reject_every_conflicting_pack(self):
        parent = self.create_pack(
            plugin_name="ParentNamespacePlugin",
            pack_id="com.example.parent-namespace",
            python_package="parent_namespace_pack",
            command_namespace="studio.assets",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('studio.assets.scan')\n"
                "def scan(payload): return {}\n"
            ),
        )
        child = self.create_pack(
            plugin_name="ChildNamespacePlugin",
            pack_id="com.example.child-namespace",
            python_package="child_namespace_pack",
            command_namespace="studio.assets.validate",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('studio.assets.validate.run')\n"
                "def validate(payload): return {}\n"
            ),
        )
        adjacent = self.create_pack(
            plugin_name="AdjacentNamespacePlugin",
            pack_id="com.example.adjacent-namespace",
            python_package="adjacent_namespace_pack",
            command_namespace="studio.assets2",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('studio.assets2.scan')\n"
                "def scan(payload): return {'loaded': True}\n"
            ),
        )

        self.registry.load_tool_packs([child, adjacent, parent], [])

        self.assertNotIn("studio.assets.scan", self.registry.COMMANDS)
        self.assertNotIn("studio.assets.validate.run", self.registry.COMMANDS)
        self.assertIn("studio.assets2.scan", self.registry.COMMANDS)
        self.assertNotIn(parent.python_package, sys.modules)
        self.assertNotIn(child.python_package, sys.modules)
        self.assertIn(adjacent.python_package, sys.modules)
        self.assertEqual(
            [item["module"] for item in self.diagnostics()],
            [
                "toolpack:com.example.child-namespace",
                "toolpack:com.example.parent-namespace",
            ],
        )
        self.assertTrue(
            all("overlap" in item["error"].lower() for item in self.diagnostics())
        )

    def test_incompatible_core_api_is_rejected_before_import_and_errors_aggregate(self):
        import_marker = self.temp_root / "incompatible-imported.txt"
        incompatible = self.create_pack(
            plugin_name="IncompatiblePlugin",
            pack_id="com.example.incompatible",
            python_package="incompatible_tool_pack",
            command_namespace="incompatible",
            required_core_api=self.sdk.SDK_API_VERSION + 1,
            source=(
                "from pathlib import Path\n"
                f"Path({str(import_marker)!r}).write_text('imported', encoding='utf-8')\n"
                "raise RuntimeError('incompatible pack was imported')\n"
            ),
        )
        healthy = self.create_pack(
            plugin_name="CompatiblePlugin",
            pack_id="com.example.compatible",
            python_package="compatible_tool_pack",
            command_namespace="compatible",
            source=(
                "from unreal_editor_webui_sdk import command\n"
                "@command('compatible.echo')\n"
                "def echo(payload): return {'compatible': True}\n"
            ),
        )
        discovery_error = {
            "module": "plugin:invalid-manifest",
            "error": "Tool Pack manifest is invalid.",
        }

        self.registry.load_tool_packs(
            [incompatible, healthy],
            [discovery_error],
        )

        self.assertFalse(import_marker.exists())
        self.assertNotIn("incompatible_tool_pack", sys.modules)
        self.assertIn("compatible.echo", self.registry.COMMANDS)
        self.assertEqual(
            [item["module"] for item in self.diagnostics()],
            ["plugin:invalid-manifest", "toolpack:com.example.incompatible"],
        )
        incompatible_error = self.diagnostics()[1]["error"].lower()
        self.assertIn("core api", incompatible_error)
        self.assertNotIn("incompatible pack was imported", incompatible_error)
        status = self.tool_pack_status()
        self.assertEqual(
            status["packs"],
            [
                {
                    "provider": "com.example.compatible",
                    "packId": "com.example.compatible",
                    "pluginName": "CompatiblePlugin",
                    "pluginVersion": "1.0.0",
                    "requiredCoreApi": self.sdk.SDK_API_VERSION,
                    "state": "loaded",
                    "commandCount": 1,
                    "commands": ["compatible.echo"],
                },
                {
                    "provider": "com.example.incompatible",
                    "packId": "com.example.incompatible",
                    "pluginName": "IncompatiblePlugin",
                    "pluginVersion": "1.0.0",
                    "requiredCoreApi": self.sdk.SDK_API_VERSION + 1,
                    "state": "rejected",
                    "commandCount": 0,
                    "commands": [],
                },
                {
                    "provider": None,
                    "packId": None,
                    "pluginName": "invalid-manifest",
                    "pluginVersion": None,
                    "requiredCoreApi": None,
                    "state": "rejected",
                    "commandCount": 0,
                    "commands": [],
                },
            ],
        )
        rendered_status = json.dumps(status, ensure_ascii=False)
        self.assertNotIn(str(self.temp_root), rendered_status)
        self.assertNotIn("Traceback", rendered_status)

    def test_import_failures_and_discovery_errors_are_aggregated_in_stable_order(self):
        alpha = self.create_pack(
            plugin_name="AlphaBrokenPlugin",
            pack_id="com.example.alpha-broken",
            python_package="alpha_broken_pack",
            command_namespace="alphabroken",
            source="raise RuntimeError('alpha boom')\n",
        )
        zeta = self.create_pack(
            plugin_name="ZetaBrokenPlugin",
            pack_id="com.example.zeta-broken",
            python_package="zeta_broken_pack",
            command_namespace="zetabroken",
            source="raise RuntimeError('zeta boom')\n",
        )
        preexisting_error = {
            "module": "plugin:manifest-error",
            "error": "Manifest was rejected.",
        }

        self.registry.load_tool_packs([zeta, alpha], [preexisting_error])

        self.assertEqual(
            [item["module"] for item in self.diagnostics()],
            [
                "plugin:manifest-error",
                "toolpack:com.example.alpha-broken",
                "toolpack:com.example.zeta-broken",
            ],
        )
        rendered = json.dumps(self.diagnostics(), ensure_ascii=False)
        self.assertNotIn("Traceback", rendered)
        self.assertNotIn(str(self.temp_root), rendered)


class ToolPackDiscoveryContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry, self.sdk, self.toolpacks, self.unreal = load_runtime()
        self.temp_directory = tempfile.TemporaryDirectory()
        self.temp_root = pathlib.Path(self.temp_directory.name)

    def tearDown(self) -> None:
        self.temp_directory.cleanup()

    def manifest(
        self,
        *,
        pack_id: str,
        python_package: str,
        command_namespace: str,
        required_core_api: int | None = None,
    ) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "id": pack_id,
            "requiredCoreApi": (
                self.sdk.SDK_API_VERSION
                if required_core_api is None
                else required_core_api
            ),
            "pythonPackage": python_package,
            "commandNamespace": command_namespace,
        }

    def create_plugin(
        self,
        plugin_name: str,
        *,
        manifest: dict[str, object] | None,
        python_package: str = "fixture_tools",
        manifest_at_fixed_path: bool = True,
        create_package: bool = True,
        create_package_init: bool = True,
        plugin_version: str = "1.0.0",
    ) -> pathlib.Path:
        base_directory = self.temp_root / plugin_name
        python_root = base_directory / "Content" / "Python"
        python_root.mkdir(parents=True, exist_ok=True)

        (base_directory / f"{plugin_name}.uplugin").write_text(
            json.dumps(
                {
                    "FileVersion": 3,
                    "Version": 1,
                    "VersionName": plugin_version,
                    "CanContainContent": True,
                    "Plugins": [
                        {"Name": "UnrealEditorWebUI", "Enabled": True},
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        if create_package:
            package_directory = python_root.joinpath(*python_package.split("."))
            package_directory.mkdir(parents=True, exist_ok=True)
            if create_package_init:
                (package_directory / "__init__.py").write_text("", encoding="utf-8")

        if manifest is not None:
            manifest_path = (
                base_directory / "Content" / "UnrealEditorWebUI" / "ToolPack.json"
                if manifest_at_fixed_path
                else base_directory / "ToolPack.json"
            )
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(
                json.dumps(manifest, ensure_ascii=False),
                encoding="utf-8",
            )
        return base_directory

    def install_plugin_library(
        self,
        *,
        enabled_names: list[str],
        mounted_names: set[str],
        base_directories: dict[str, pathlib.Path],
        versions: dict[str, str],
    ) -> FakePluginBlueprintLibrary:
        library = FakePluginBlueprintLibrary(
            enabled_names=enabled_names,
            mounted_names=mounted_names,
            base_directories=base_directories,
            versions=versions,
        )
        self.unreal.PluginBlueprintLibrary = library
        return library

    def test_discovery_uses_only_enabled_mounted_plugins_and_fixed_paths(self):
        alpha_manifest = self.manifest(
            pack_id="com.example.alpha-discovery",
            python_package="alpha_discovery_tools",
            command_namespace="alphadiscovery",
        )
        zeta_manifest = self.manifest(
            pack_id="com.example.zeta-discovery",
            python_package="zeta_discovery_tools",
            command_namespace="zetadiscovery",
        )
        unmounted_manifest = self.manifest(
            pack_id="com.example.unmounted",
            python_package="unmounted_tools",
            command_namespace="unmounted",
        )
        disabled_manifest = self.manifest(
            pack_id="com.example.disabled",
            python_package="disabled_tools",
            command_namespace="disabled",
        )
        misplaced_manifest = self.manifest(
            pack_id="com.example.misplaced",
            python_package="misplaced_tools",
            command_namespace="misplaced",
        )

        base_directories = {
            "AlphaPlugin": self.create_plugin(
                "AlphaPlugin",
                manifest=alpha_manifest,
                python_package="alpha_discovery_tools",
                plugin_version="1.2.3",
            ),
            "ZetaPlugin": self.create_plugin(
                "ZetaPlugin",
                manifest=zeta_manifest,
                python_package="zeta_discovery_tools",
                plugin_version="4.5.6",
            ),
            "UnmountedPlugin": self.create_plugin(
                "UnmountedPlugin",
                manifest=unmounted_manifest,
                python_package="unmounted_tools",
            ),
            "DisabledPlugin": self.create_plugin(
                "DisabledPlugin",
                manifest=disabled_manifest,
                python_package="disabled_tools",
            ),
            "MisplacedPlugin": self.create_plugin(
                "MisplacedPlugin",
                manifest=misplaced_manifest,
                python_package="misplaced_tools",
                manifest_at_fixed_path=False,
            ),
            "NoManifestPlugin": self.create_plugin(
                "NoManifestPlugin",
                manifest=None,
            ),
        }
        # A mounted plugin without the fixed manifest is not a Tool Pack. Runtime discovery
        # must skip it silently without parsing an unrelated or even malformed descriptor.
        (
            base_directories["NoManifestPlugin"]
            / "NoManifestPlugin.uplugin"
        ).write_text("{", encoding="utf-8")
        library = self.install_plugin_library(
            enabled_names=[
                "ZetaPlugin",
                "UnmountedPlugin",
                "NoManifestPlugin",
                "MisplacedPlugin",
                "AlphaPlugin",
                "ZetaPlugin",
            ],
            mounted_names={
                "AlphaPlugin",
                "ZetaPlugin",
                "DisabledPlugin",
                "MisplacedPlugin",
                "NoManifestPlugin",
            },
            base_directories=base_directories,
            versions={
                "AlphaPlugin": "1.2.3",
                "ZetaPlugin": "4.5.6",
                "UnmountedPlugin": "7.8.9",
                "DisabledPlugin": "10.11.12",
                "MisplacedPlugin": "13.14.15",
                "NoManifestPlugin": "16.17.18",
            },
        )

        descriptors, errors = self.toolpacks.discover_tool_packs(
            self.sdk.SDK_API_VERSION
        )

        self.assertEqual(errors, [])
        self.assertEqual(
            [descriptor.pack_id for descriptor in descriptors],
            ["com.example.alpha-discovery", "com.example.zeta-discovery"],
        )
        self.assertEqual(
            [descriptor.plugin_version for descriptor in descriptors],
            ["1.2.3", "4.5.6"],
        )
        self.assertEqual(
            [descriptor.python_root for descriptor in descriptors],
            [
                (base_directories["AlphaPlugin"] / "Content" / "Python").resolve(),
                (base_directories["ZetaPlugin"] / "Content" / "Python").resolve(),
            ],
        )
        self.assertNotIn("DisabledPlugin", library.mounted_calls)
        self.assertNotIn("UnmountedPlugin", library.base_directory_calls)
        self.assertNotIn("DisabledPlugin", library.base_directory_calls)
        self.assertEqual(library.version_calls, ["AlphaPlugin", "ZetaPlugin"])
        self.assertIn("MisplacedPlugin", library.base_directory_calls)
        self.assertIn("NoManifestPlugin", library.base_directory_calls)

    def test_invalid_manifests_packages_and_escape_names_return_only_safe_diagnostics(self):
        unknown_key_manifest = self.manifest(
            pack_id="com.example.unknown-key",
            python_package="unknown_key_tools",
            command_namespace="unknownkey",
        )
        unknown_key_manifest["unexpected"] = True
        incompatible_manifest = self.manifest(
            pack_id="com.example.incompatible-discovery",
            python_package="incompatible_discovery_tools",
            command_namespace="incompatiblediscovery",
            required_core_api=self.sdk.SDK_API_VERSION + 1,
        )
        non_package_manifest = self.manifest(
            pack_id="com.example.non-package",
            python_package="non_package_tools",
            command_namespace="nonpackage",
        )
        escape_name_manifest = self.manifest(
            pack_id="com.example.escape-name",
            python_package="../outside_tools",
            command_namespace="escapename",
        )

        base_directories = {
            "UnknownKeyPlugin": self.create_plugin(
                "UnknownKeyPlugin",
                manifest=unknown_key_manifest,
                python_package="unknown_key_tools",
            ),
            "IncompatiblePlugin": self.create_plugin(
                "IncompatiblePlugin",
                manifest=incompatible_manifest,
                python_package="incompatible_discovery_tools",
            ),
            "NonPackagePlugin": self.create_plugin(
                "NonPackagePlugin",
                manifest=non_package_manifest,
                python_package="non_package_tools",
                create_package_init=False,
            ),
            "EscapeNamePlugin": self.create_plugin(
                "EscapeNamePlugin",
                manifest=escape_name_manifest,
                create_package=False,
            ),
        }
        library = self.install_plugin_library(
            enabled_names=list(reversed(base_directories)),
            mounted_names=set(base_directories),
            base_directories=base_directories,
            versions={plugin_name: "1.0.0" for plugin_name in base_directories},
        )

        descriptors, errors = self.toolpacks.discover_tool_packs(
            self.sdk.SDK_API_VERSION
        )

        self.assertEqual(descriptors, [])
        self.assertEqual(
            [error["module"] for error in errors],
            [
                "plugin:EscapeNamePlugin",
                "plugin:IncompatiblePlugin",
                "plugin:NonPackagePlugin",
                "plugin:UnknownKeyPlugin",
            ],
        )
        self.assertEqual(library.version_calls, [])
        rendered_errors = json.dumps(errors, ensure_ascii=False)
        self.assertNotIn("Traceback", rendered_errors)
        self.assertNotIn(str(self.temp_root), rendered_errors)
        self.assertTrue(all(error["error"].strip() for error in errors))
        self.assertIn("core api", errors[1]["error"].lower())

    def test_incompatible_discovery_load_reports_only_sanitized_available_status(self):
        plugin_name = "IncompatibleStatusPlugin"
        manifest = self.manifest(
            pack_id="com.example.incompatible-status",
            python_package="incompatible_status_tools",
            command_namespace="incompatiblestatus",
            required_core_api=self.sdk.SDK_API_VERSION + 1,
        )
        base_directory = self.create_plugin(
            plugin_name,
            manifest=manifest,
            python_package="incompatible_status_tools",
        )
        self.install_plugin_library(
            enabled_names=[plugin_name],
            mounted_names={plugin_name},
            base_directories={plugin_name: base_directory},
            versions={plugin_name: "7.8.9"},
        )

        descriptors, errors = self.toolpacks.discover_tool_packs(
            self.sdk.SDK_API_VERSION
        )
        self.registry.load_tool_packs(descriptors, errors)
        response = json.loads(
            self.registry.execute_command(request("system.toolPacks"))
        )

        self.assertEqual(descriptors, [])
        self.assertEqual(len(errors), 1)
        self.assertTrue(response["ok"])
        self.assertEqual(
            response["result"]["packs"],
            [
                {
                    "provider": None,
                    "packId": None,
                    "pluginName": plugin_name,
                    "pluginVersion": None,
                    "requiredCoreApi": None,
                    "state": "rejected",
                    "commandCount": 0,
                    "commands": [],
                }
            ],
        )
        self.assertEqual(response["result"]["truncatedCount"], 0)

    def test_mounted_version_mismatch_rejects_instead_of_masking_descriptor_version(self):
        plugin_name = "VersionMismatchPlugin"
        manifest = self.manifest(
            pack_id="com.example.version-mismatch",
            python_package="version_mismatch_tools",
            command_namespace="versionmismatch",
        )
        base_directory = self.create_plugin(
            plugin_name,
            manifest=manifest,
            python_package="version_mismatch_tools",
            plugin_version="1.2.3",
        )
        library = self.install_plugin_library(
            enabled_names=[plugin_name],
            mounted_names={plugin_name},
            base_directories={plugin_name: base_directory},
            versions={plugin_name: "9.9.9"},
        )

        descriptors, errors = self.toolpacks.discover_tool_packs(
            self.sdk.SDK_API_VERSION
        )

        self.assertEqual(descriptors, [])
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["module"], f"plugin:{plugin_name}")
        self.assertIn("[plugin_version_mismatch]", errors[0]["error"])
        self.assertNotIn("1.2.3", errors[0]["error"])
        self.assertNotIn("9.9.9", errors[0]["error"])
        self.assertEqual(library.version_calls, [plugin_name])

    def test_mounted_plugin_name_mismatch_rejects_descriptor_spoof(self):
        descriptor_name = "DescriptorPlugin"
        mounted_name = "MountedAlias"
        manifest = self.manifest(
            pack_id="com.example.name-mismatch",
            python_package="name_mismatch_tools",
            command_namespace="namemismatch",
        )
        base_directory = self.create_plugin(
            descriptor_name,
            manifest=manifest,
            python_package="name_mismatch_tools",
            plugin_version="1.2.3",
        )
        library = self.install_plugin_library(
            enabled_names=[mounted_name],
            mounted_names={mounted_name},
            base_directories={mounted_name: base_directory},
            versions={mounted_name: "1.2.3"},
        )

        descriptors, errors = self.toolpacks.discover_tool_packs(
            self.sdk.SDK_API_VERSION
        )

        self.assertEqual(descriptors, [])
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["module"], f"plugin:{mounted_name}")
        self.assertIn("[plugin_name_mismatch]", errors[0]["error"])
        self.assertNotIn(descriptor_name, errors[0]["error"])
        self.assertNotIn(mounted_name, errors[0]["error"])
        self.assertEqual(library.version_calls, [])

    def test_manifest_symlink_escape_is_rejected_without_leaking_the_target_path(self):
        plugin_name = "EscapingManifestPlugin"
        base_directory = self.create_plugin(
            plugin_name,
            manifest=None,
            python_package="escaping_manifest_tools",
        )
        external_directory = self.temp_root / "private-external-manifest"
        external_directory.mkdir()
        external_manifest = external_directory / "ToolPack.json"
        external_manifest.write_text(
            json.dumps(
                self.manifest(
                    pack_id="com.example.escaping-manifest",
                    python_package="escaping_manifest_tools",
                    command_namespace="escapingmanifest",
                )
            ),
            encoding="utf-8",
        )
        manifest_path = (
            base_directory / "Content" / "UnrealEditorWebUI" / "ToolPack.json"
        )
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            manifest_path.symlink_to(external_manifest)
        except OSError as exc:
            if sys.platform != "win32":
                self.skipTest(f"The host does not permit file symlinks: {exc}")

            # Windows directory junctions do not require symbolic-link privilege.
            # Point the fixed manifest directory outside the plugin so the same
            # canonical containment check is exercised on restricted CI hosts.
            manifest_path.parent.rmdir()
            junction = subprocess.run(
                [
                    "cmd.exe",
                    "/d",
                    "/c",
                    "mklink",
                    "/J",
                    str(manifest_path.parent),
                    str(external_directory),
                ],
                check=False,
                capture_output=True,
                text=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if junction.returncode != 0:
                self.skipTest(
                    "The host permits neither file symlinks nor directory junctions."
                )

        self.install_plugin_library(
            enabled_names=[plugin_name],
            mounted_names={plugin_name},
            base_directories={plugin_name: base_directory},
            versions={plugin_name: "1.0.0"},
        )

        descriptors, errors = self.toolpacks.discover_tool_packs(
            self.sdk.SDK_API_VERSION
        )

        self.assertEqual(descriptors, [])
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["module"], f"plugin:{plugin_name}")
        rendered_error = json.dumps(errors[0], ensure_ascii=False)
        self.assertNotIn("Traceback", rendered_error)
        self.assertNotIn(str(external_manifest), rendered_error)


if __name__ == "__main__":
    unittest.main()
