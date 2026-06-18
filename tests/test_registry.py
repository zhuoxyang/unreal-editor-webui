import importlib.util
import json
import pathlib
import sys
import types
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
REGISTRY_PATH = REPO_ROOT / "Python" / "unreal_editor_webui_registry.py"


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

    spec = importlib.util.spec_from_file_location("registry_under_test", REGISTRY_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module, unreal


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
        self.assertEqual(self.unreal.logs, ["hello"])

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

    def test_inspect_command_returns_permission_metadata(self):
        response = parse_response(self.registry.inspect_command(request("editor.log")))

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["command"], "editor.log")
        self.assertEqual(response["result"]["permission"], "write")

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

    def test_schema_validation_rejects_wrong_field_type(self):
        response = parse_response(
            self.registry.execute_command(
                request("asset.listByPath", {"path": "/Game", "recursive": "yes"})
            )
        )

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "invalid_payload")
        self.assertIn("Field 'recursive' must be boolean.", response["error"]["details"])

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


if __name__ == "__main__":
    unittest.main()
