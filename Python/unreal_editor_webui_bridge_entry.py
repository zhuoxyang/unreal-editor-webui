from __future__ import annotations

import base64
import json
import traceback
from typing import Any


class _RawJsonResult:
    def __init__(self, response_json: str) -> None:
        self.response_json = response_json

    def __repr__(self) -> str:
        return self.response_json


def _error(request_id: str | None, code: str, message: str) -> str:
    return json.dumps(
        {
            "id": request_id,
            "ok": False,
            "error": {
                "code": code,
                "message": message,
            },
        },
        ensure_ascii=False,
    )


def _request_id_from_json(request_json: str) -> str | None:
    if len(request_json.encode("utf-8")) > 256 * 1024:
        return None
    try:
        request = json.loads(request_json)
    except Exception:
        return None

    if isinstance(request, dict):
        request_id = request.get("id")
        if isinstance(request_id, str):
            return request_id

    return None


def _decode_base64_utf8(value: str) -> str:
    return base64.b64decode(value.encode("ascii")).decode("utf-8")


def _log_exception(prefix: str) -> None:
    traceback_text = traceback.format_exc()
    try:
        import unreal

        log_error = getattr(unreal, "log_error", None)
        if callable(log_error):
            log_error(f"{prefix}\n{traceback_text}")
        else:
            unreal.log(f"{prefix}\n{traceback_text}")
    except Exception:
        print(f"{prefix}\n{traceback_text}")


def dispatch(function_name: str, request_json: str, permission_policy_json: str = "") -> str:
    """Dispatch a bridge request to the Python command registry and return JSON."""

    request_id = _request_id_from_json(request_json)

    try:
        from unreal_editor_webui_registry import (
            cancel_all_cooperative_commands,
            execute_command,
            inspect_command,
            parse_json_document,
            start_cooperative_command,
            step_cooperative_command,
        )

        if function_name == "inspect_command":
            return inspect_command(request_json)

        if function_name == "execute_command":
            permission_policy: dict[str, Any] = {}
            if permission_policy_json:
                loaded_policy = parse_json_document(permission_policy_json, max_bytes=16 * 1024)
                if isinstance(loaded_policy, dict):
                    permission_policy = loaded_policy
            return execute_command(request_json, permission_policy)

        if function_name == "start_cooperative_command":
            permission_policy: dict[str, Any] = {}
            if permission_policy_json:
                loaded_policy = parse_json_document(permission_policy_json, max_bytes=16 * 1024)
                if isinstance(loaded_policy, dict):
                    permission_policy = loaded_policy
            task_id = permission_policy.pop("taskId", "")
            return start_cooperative_command(request_json, permission_policy, task_id)

        if function_name == "step_cooperative_command":
            return step_cooperative_command(request_json)

        if function_name == "cancel_all_cooperative_commands":
            return cancel_all_cooperative_commands(request_json)

        return _error(
            request_id,
            "unsupported_registry_function",
            f"Unsupported registry function: {function_name}",
        )

    except Exception as exc:
        error_code = getattr(exc, "code", None)
        if isinstance(error_code, str):
            return _error(request_id, error_code, str(exc))
        _log_exception("Unreal Editor WebUI Python bridge dispatch failed.")
        return _error(request_id, "python_exception", str(exc))


def dispatch_for_unreal(function_name_b64: str, request_json_b64: str, permission_policy_json_b64: str = "") -> _RawJsonResult:
    """Decode C++ bridge arguments and return a repr-safe JSON wrapper for UE."""

    try:
        function_name = _decode_base64_utf8(function_name_b64)
        request_json = _decode_base64_utf8(request_json_b64)
        permission_policy_json = _decode_base64_utf8(permission_policy_json_b64) if permission_policy_json_b64 else ""
        return _RawJsonResult(dispatch(function_name, request_json, permission_policy_json))
    except Exception as exc:
        _log_exception("Unreal Editor WebUI Python bridge argument decoding failed.")
        return _RawJsonResult(_error(None, "python_exception", str(exc)))
