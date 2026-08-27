#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PYTHON_ROOT = REPOSITORY_ROOT / "Python"
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

from unreal_editor_webui_toolpacks import (  # noqa: E402
    ToolPackDescriptor,
    ToolPackValidationIssue,
    validate_tool_pack_directories,
)


def _pack_document(descriptor: ToolPackDescriptor) -> dict[str, Any]:
    return {
        "commandNamespace": descriptor.command_namespace,
        "packId": descriptor.pack_id,
        "pluginName": descriptor.plugin_name,
        "pluginVersion": descriptor.plugin_version,
        "pythonPackage": descriptor.python_package,
        "requiredCoreApi": descriptor.required_core_api,
    }


def _issue_document(issue: ToolPackValidationIssue) -> dict[str, str]:
    return {
        "message": issue.message,
        "pluginName": issue.plugin_name,
        "reasonCode": issue.reason_code,
    }


def _json_document(report: Any) -> dict[str, Any]:
    return {
        "issues": [_issue_document(issue) for issue in report.issues],
        "packs": [
            _pack_document(descriptor)
            for descriptor in report.candidate_descriptors
        ],
        "schemaVersion": 1,
        "valid": report.valid,
    }


def _render_human(report: Any) -> str:
    lines: list[str] = []
    for descriptor in report.candidate_descriptors:
        lines.append(f"OK {descriptor.plugin_name} ({descriptor.pack_id})")
    for issue in report.issues:
        lines.append(
            f"ERROR {issue.plugin_name} [{issue.reason_code}] {issue.message}"
        )
    if report.valid:
        lines.append(
            f"Validated {len(report.candidate_descriptors)} Tool Pack(s)."
        )
    else:
        lines.append(f"Validation failed with {len(report.issues)} issue(s).")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate one or more Unreal Editor WebUI Tool Pack plugins.",
    )
    parser.add_argument(
        "--plugin-dir",
        action="append",
        required=True,
        dest="plugin_directories",
        help="Tool Pack plugin directory. Repeat for multi-pack conflict checks.",
    )
    parser.add_argument(
        "--format",
        choices=("human", "json"),
        default="human",
        help="Output format (default: human).",
    )
    args = parser.parse_args(argv)

    report = validate_tool_pack_directories(args.plugin_directories)
    if args.format == "json":
        sys.stdout.write(
            json.dumps(
                _json_document(report),
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
    else:
        sys.stdout.write(_render_human(report))
    return 0 if report.valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
