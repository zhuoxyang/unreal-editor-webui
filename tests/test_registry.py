import importlib.util
import base64
import json
import pathlib
import sys
import tempfile
import types
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
REGISTRY_PATH = REPO_ROOT / "Python" / "unreal_editor_webui_registry.py"
BRIDGE_ENTRY_PATH = REPO_ROOT / "Python" / "unreal_editor_webui_bridge_entry.py"


def make_unreal_stub():
    logs = []
    error_logs = []

    unreal = types.SimpleNamespace(
        log=logs.append,
        log_error=error_logs.append,
        SystemLibrary=types.SimpleNamespace(get_project_name=lambda: "TestProject"),
        Paths=types.SimpleNamespace(project_dir=lambda: "/TestProject/"),
        EditorUtilityLibrary=types.SimpleNamespace(get_selected_assets=lambda: []),
        AssetRegistryHelpers=types.SimpleNamespace(
            get_asset_registry=lambda: types.SimpleNamespace(get_assets_by_path=lambda path, recursive: [])
        ),
    )
    unreal.logs = logs
    unreal.error_logs = error_logs
    return unreal


def load_registry():
    unreal = make_unreal_stub()
    sys.modules["unreal"] = unreal
    python_dir = str(REGISTRY_PATH.parent)
    if python_dir not in sys.path:
        sys.path.insert(0, python_dir)

    for module_name in list(sys.modules):
        if module_name == "unreal_editor_webui_registry" or module_name.startswith("unreal_editor_webui_commands"):
            del sys.modules[module_name]

    spec = importlib.util.spec_from_file_location("unreal_editor_webui_registry", REGISTRY_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["unreal_editor_webui_registry"] = module
    spec.loader.exec_module(module)
    return module, unreal


def load_bridge_entry():
    registry, unreal = load_registry()
    spec = importlib.util.spec_from_file_location("unreal_editor_webui_bridge_entry", BRIDGE_ENTRY_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["unreal_editor_webui_bridge_entry"] = module
    spec.loader.exec_module(module)
    return module, registry, unreal


def request(command, payload=None, request_id="req-1"):
    return json.dumps(
        {
            "id": request_id,
            "command": command,
            "payload": payload or {},
        }
    )


def parse_response(response_json):
    return json.loads(response_json)


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.registry, self.unreal = load_registry()

    def test_read_command_executes_without_permission_policy(self):
        response = parse_response(
            self.registry.execute_command(request("system.ping", {"source": "unit-test"}))
        )

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["message"], "pong")
        self.assertEqual(response["result"]["echo"]["source"], "unit-test")

    def test_write_command_is_denied_by_default(self):
        response = parse_response(
            self.registry.execute_command(request("editor.log", {"message": "hello"}))
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "permission_denied")
        self.assertEqual(self.unreal.logs, [])

    def test_write_command_runs_when_policy_allows_it(self):
        response = parse_response(
            self.registry.execute_command(
                request("editor.log", {"message": "hello"}),
                {"allowedCommand": "editor.log", "allowedPermission": "write"},
            )
        )

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["logged"], "hello")
        self.assertFalse(response["result"]["dryRun"])
        self.assertEqual(self.unreal.logs, ["hello"])

    def test_dry_run_write_command_skips_unreal_log(self):
        response = parse_response(
            self.registry.execute_command(
                request("editor.log", {"message": "hello", "dryRun": True}),
                {"allowedCommand": "editor.log", "allowedPermission": "write"},
            )
        )

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["logged"], "hello")
        self.assertTrue(response["result"]["dryRun"])
        self.assertEqual(self.unreal.logs, [])

    def test_broad_write_policy_does_not_allow_write_command(self):
        response = parse_response(
            self.registry.execute_command(
                request("editor.log", {"message": "hello"}),
                {"allowWriteCommands": True},
            )
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "permission_denied")
        self.assertEqual(self.unreal.logs, [])

    def test_destructive_command_requires_destructive_policy(self):
        @self.registry.command("test.destroy", permission="destructive")
        def destroy(payload):
            return {"destroyed": True}

        write_only = parse_response(
            self.registry.execute_command(
                request("test.destroy"),
                {"allowedCommand": "test.destroy", "allowedPermission": "write"},
            )
        )
        destructive_allowed = parse_response(
            self.registry.execute_command(
                request("test.destroy"),
                {"allowedCommand": "test.destroy", "allowedPermission": "destructive"},
            )
        )

        self.assertFalse(write_only["ok"])
        self.assertEqual(write_only["error"]["code"], "permission_denied")
        self.assertTrue(destructive_allowed["ok"])
        self.assertTrue(destructive_allowed["result"]["destroyed"])

    def test_unknown_permission_is_rejected_during_registration(self):
        with self.assertRaisesRegex(ValueError, "unsupported permission"):
            self.registry.command("test.permissionTypo", permission="wrtie")

    def test_tampered_unknown_permission_fails_closed(self):
        self.registry.COMMAND_METADATA["editor.log"]["permission"] = "wrtie"
        response = parse_response(
            self.registry.execute_command(
                request("editor.log", {"message": "must not run"}),
                {"allowedCommand": "editor.log", "allowedPermission": "wrtie"},
            )
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "permission_denied")
        self.assertEqual(self.unreal.logs, [])

    def test_duplicate_command_registration_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "already registered"):
            self.registry.command("system.ping")

    def test_unknown_schema_type_is_rejected_during_registration(self):
        with self.assertRaisesRegex(ValueError, "unsupported type"):
            self.registry.command(
                "test.invalidSchema",
                schema={
                    "type": "object",
                    "properties": {"value": {"type": "strnig"}},
                },
            )

    def test_inspect_command_returns_permission_metadata(self):
        response = parse_response(self.registry.inspect_command(request("editor.log", {"message": "hello"})))

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["command"], "editor.log")
        self.assertEqual(response["result"]["permission"], "write")
        self.assertEqual(response["result"]["execution"]["thread"], "editor_game_thread")
        self.assertEqual(response["result"]["execution"]["cancellationMode"], "queued_only")
        self.assertEqual(response["result"]["execution"]["timeoutPolicy"], "none")
        self.assertTrue(response["result"]["payloadValid"])

    def test_unknown_command_is_rejected(self):
        response = parse_response(self.registry.execute_command(request("missing.command")))
        inspect_response = parse_response(self.registry.inspect_command(request("missing.command")))

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "unknown_command")
        self.assertFalse(inspect_response["ok"])
        self.assertEqual(inspect_response["error"]["code"], "unknown_command")

    def test_schema_validation_rejects_missing_required_field(self):
        response = parse_response(
            self.registry.execute_command(
                request("editor.log"),
                {"allowedCommand": "editor.log", "allowedPermission": "write"},
            )
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "invalid_payload")
        self.assertIn("Missing required field: message", response["error"]["details"])

    def test_inspect_command_rejects_invalid_payload_before_execution(self):
        response = parse_response(self.registry.inspect_command(request("editor.log")))

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "invalid_payload")
        self.assertIn("Missing required field: message", response["error"]["details"])
        self.assertEqual(self.unreal.logs, [])

    def test_inspect_command_applies_defaults_to_normalized_payload(self):
        response = parse_response(self.registry.inspect_command(request("asset.listByPath", {})))

        self.assertTrue(response["ok"])
        self.assertTrue(response["result"]["payloadValid"])
        self.assertEqual(response["result"]["normalizedPayload"]["path"], "/Game")
        self.assertTrue(response["result"]["normalizedPayload"]["recursive"])
        self.assertEqual(response["result"]["normalizedPayload"]["limit"], 50)

    def test_schema_validation_rejects_wrong_field_type(self):
        response = parse_response(
            self.registry.execute_command(
                request("asset.listByPath", {"path": "/Game", "recursive": "yes"})
            )
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "invalid_payload")
        self.assertIn("Field 'recursive' must be boolean.", response["error"]["details"])

    def test_schema_defaults_are_applied_before_handler_dispatch(self):
        response = parse_response(
            self.registry.execute_command(request("asset.listByPath", {}))
        )

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["path"], "/Game")
        self.assertFalse(response["result"]["truncated"])

    def test_schema_validation_rejects_numeric_bounds(self):
        response = parse_response(
            self.registry.execute_command(
                request("asset.listByPath", {"path": "/Game", "limit": 0})
            )
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "invalid_payload")
        self.assertIn(
            "Field 'limit' must be greater than or equal to 1.",
            response["error"]["details"],
        )

    def test_schema_validation_handles_nested_objects_and_arrays(self):
        @self.registry.command(
            "test.schema",
            schema={
                "type": "object",
                "properties": {
                    "filters": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 2,
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": {"type": "string", "minLength": 2},
                                "values": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "minItems": 1,
                                },
                            },
                            "required": ["field", "values"],
                            "additionalProperties": False,
                        },
                    },
                    "options": {
                        "type": "object",
                        "properties": {
                            "limit": {"type": "integer", "default": 2, "minimum": 1, "maximum": 5},
                        },
                        "additionalProperties": False,
                    },
                },
                "required": ["filters"],
                "additionalProperties": False,
            },
        )
        def nested_schema(payload):
            return payload

        invalid = parse_response(
            self.registry.execute_command(
                request(
                    "test.schema",
                    {
                        "filters": [{"field": "x", "values": []}],
                        "options": {"unexpected": True},
                    },
                )
            )
        )
        valid = parse_response(
            self.registry.execute_command(
                request(
                    "test.schema",
                    {
                        "filters": [{"field": "name", "values": ["SM_Chair"]}],
                        "options": {},
                    },
                )
            )
        )

        self.assertFalse(invalid["ok"])
        self.assertEqual(invalid["error"]["code"], "invalid_payload")
        self.assertIn(
            "Field 'filters[0].field' must be at least 2 characters.",
            invalid["error"]["details"],
        )
        self.assertIn(
            "Field 'filters[0].values' must include at least 1 items.",
            invalid["error"]["details"],
        )
        self.assertIn("Unexpected field: options.unexpected", invalid["error"]["details"])
        self.assertTrue(valid["ok"])
        self.assertEqual(valid["result"]["options"]["limit"], 2)

    def test_command_metadata_exposes_dry_run_marker(self):
        response = parse_response(self.registry.execute_command(request("system.commands")))

        self.assertTrue(response["ok"])
        commands = {command["name"]: command for command in response["result"]["commands"]}
        editor_log = commands["editor.log"]
        self.assertTrue(editor_log["supportsDryRun"])
        self.assertTrue(editor_log["schema"]["properties"]["dryRun"]["xDryRun"])
        self.assertEqual(editor_log["execution"]["thread"], "editor_game_thread")
        rename_batch = commands["asset.renameBatch"]
        self.assertTrue(rename_batch["supportsDryRun"])
        self.assertTrue(rename_batch["schema"]["properties"]["dryRun"]["xDryRun"])
        self.assertEqual(rename_batch["metadataVersion"], 1)
        self.assertEqual(rename_batch["category"], "Assets")
        self.assertEqual(rename_batch["icon"], "edit-3")
        self.assertEqual(rename_batch["resultType"], "changeSet")
        self.assertIn("asset", rename_batch["tags"])

    def test_command_module_load_errors_are_reported_without_clearing_healthy_commands(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            package_dir = pathlib.Path(temp_dir) / "broken_command_package"
            package_dir.mkdir()
            (package_dir / "__init__.py").write_text("", encoding="utf-8")
            (package_dir / "broken.py").write_text("raise RuntimeError('broken import')\n", encoding="utf-8")
            sys.path.insert(0, temp_dir)
            try:
                self.registry.load_command_modules("broken_command_package")
            finally:
                sys.path.remove(temp_dir)

        self.assertIn("system.ping", self.registry.COMMANDS)
        self.assertEqual(len(self.registry.COMMAND_LOAD_ERRORS), 1)
        self.assertEqual(self.registry.COMMAND_LOAD_ERRORS[0]["module"], "broken_command_package.broken")
        self.assertIn("broken import", self.registry.COMMAND_LOAD_ERRORS[0]["error"])

    def test_batch_rename_dry_run_returns_change_set(self):
        response = parse_response(
            self.registry.execute_command(
                request(
                    "asset.renameBatch",
                    {
                        "assetPaths": ["/Game/Props/SM_OldChair", "/Game/Props/SM_Table"],
                        "search": "Old",
                        "replace": "New",
                    },
                ),
                {"allowedCommand": "asset.renameBatch", "allowedPermission": "write"},
            )
        )

        self.assertTrue(response["ok"])
        result = response["result"]
        self.assertEqual(result["view"], "changeSet")
        self.assertTrue(result["summary"]["dryRun"])
        self.assertEqual(result["summary"]["changed"], 1)
        self.assertEqual(result["summary"]["skipped"], 1)
        self.assertEqual(result["changeSet"][0]["after"], "/Game/Props/SM_NewChair")

    def test_batch_rename_apply_reports_changed_and_failed_assets(self):
        renamed = []

        class EditorAssetLibrary:
            @staticmethod
            def rename_asset(source, target):
                renamed.append((source, target))
                return "Fail" not in source

        self.unreal.EditorAssetLibrary = EditorAssetLibrary
        response = parse_response(
            self.registry.execute_command(
                request(
                    "asset.renameBatch",
                    {
                        "assetPaths": ["/Game/Props/SM_OldChair", "/Game/Props/SM_OldFail"],
                        "search": "Old",
                        "replace": "New",
                        "dryRun": False,
                    },
                ),
                {"allowedCommand": "asset.renameBatch", "allowedPermission": "write"},
            )
        )

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["summary"]["changed"], 1)
        self.assertEqual(response["result"]["summary"]["failed"], 1)
        self.assertEqual(
            renamed,
            [
                ("/Game/Props/SM_OldChair", "/Game/Props/SM_NewChair"),
                ("/Game/Props/SM_OldFail", "/Game/Props/SM_NewFail"),
            ],
        )

    def test_asset_naming_validation_returns_issue_table(self):
        response = parse_response(
            self.registry.execute_command(
                request(
                    "asset.validateNaming",
                    {
                        "assetPaths": ["/Game/Props/Chair", "/Game/Props/SM_Table", "/Game/Bad Path/T_Rock"],
                    },
                )
            )
        )

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["view"], "issueTable")
        self.assertEqual(response["result"]["summary"]["checked"], 3)
        self.assertEqual(response["result"]["summary"]["issues"], 2)
        self.assertEqual(response["result"]["issues"][0]["severity"], "warning")

    def test_texture_budget_validation_reports_oversized_textures(self):
        response = parse_response(
            self.registry.execute_command(
                request(
                    "asset.validateTextureBudget",
                    {
                        "textures": [
                            {"path": "/Game/T_OK", "width": 1024, "height": 1024},
                            {"path": "/Game/T_Huge", "width": 8192, "height": 4096},
                        ],
                        "maxSize": 4096,
                    },
                )
            )
        )

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["summary"]["issues"], 1)
        self.assertEqual(response["result"]["issues"][0]["assetPath"], "/Game/T_Huge")

    def test_redirector_scan_reports_potential_redirectors(self):
        response = parse_response(
            self.registry.execute_command(
                request(
                    "asset.scanRedirectors",
                    {
                        "assetPaths": ["/Game/Old/Redirector_Chair", "/Game/Props/SM_Table"],
                    },
                )
            )
        )

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["summary"]["issues"], 1)
        self.assertIn("Redirector", response["result"]["issues"][0]["assetPath"])

    def test_long_run_demo_exposes_cooperative_execution_metadata(self):
        response = parse_response(self.registry.inspect_command(request("demo.longRun", {"steps": 3})))

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["execution"]["thread"], "editor_tick")
        self.assertEqual(response["result"]["execution"]["cancellationMode"], "cooperative")
        self.assertEqual(response["result"]["execution"]["timeoutPolicy"], "seconds:10")
        self.assertEqual(response["result"]["normalizedPayload"]["steps"], 3)

    def test_handler_exception_hides_traceback_from_response(self):
        @self.registry.command("test.raise")
        def raise_error(payload):
            raise RuntimeError("boom")

        response = parse_response(self.registry.execute_command(request("test.raise")))

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "handler_exception")
        self.assertEqual(response["error"]["message"], "boom")
        self.assertNotIn("traceback", response["error"])
        self.assertEqual(len(self.unreal.error_logs), 1)
        self.assertIn("RuntimeError: boom", self.unreal.error_logs[0])


class BridgeEntryTests(unittest.TestCase):
    def setUp(self):
        self.entry, self.registry, self.unreal = load_bridge_entry()

    def test_dispatch_inspects_command_metadata(self):
        response = parse_response(self.entry.dispatch("inspect_command", request("system.ping")))

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["command"], "system.ping")
        self.assertEqual(response["result"]["permission"], "read")

    def test_dispatch_executes_command_with_permission_policy(self):
        response = parse_response(
            self.entry.dispatch(
                "execute_command",
                request("editor.log", {"message": "from entry"}),
                json.dumps({"allowedCommand": "editor.log", "allowedPermission": "write"}),
            )
        )

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["logged"], "from entry")
        self.assertEqual(self.unreal.logs, ["from entry"])

    def test_unreal_dispatch_wrapper_repr_is_raw_json(self):
        response_repr = repr(
            self.entry.dispatch_for_unreal(
                base64.b64encode(b"inspect_command").decode("ascii"),
                base64.b64encode(request("system.ping").encode("utf-8")).decode("ascii"),
                "",
            )
        )

        response = parse_response(response_repr)
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["command"], "system.ping")


if __name__ == "__main__":
    unittest.main()
