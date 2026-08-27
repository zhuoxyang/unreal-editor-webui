#!/usr/bin/env python3
"""Create a fresh external-plugin-only Unreal project for Rez validation."""

from __future__ import annotations

import argparse
import json
import os
import stat
import tempfile
from pathlib import Path


ASSOCIATIONS = frozenset({"5.4", "5.5", "5.8"})


def _is_reparse(value: os.stat_result) -> bool:
    return stat.S_ISLNK(value.st_mode) or bool(
        getattr(value, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def create_project(project_directory: Path, engine_association: str) -> Path:
    if engine_association not in ASSOCIATIONS:
        raise ValueError("Engine association must be exactly 5.4, 5.5, or 5.8.")
    if ";" in str(project_directory):
        raise ValueError("Project paths containing semicolons cannot be represented safely.")
    if project_directory.exists() or os.path.lexists(str(project_directory)):
        raise ValueError("External Rez host project directory must be fresh.")
    parent = project_directory.parent
    parent_stat = parent.lstat()
    if _is_reparse(parent_stat) or not stat.S_ISDIR(parent_stat.st_mode):
        raise ValueError("External Rez host project parent must be a real directory.")

    descriptor = {
        "Category": "Validation",
        "Description": "External-path-only UnrealEditorWebUI Rez validation host.",
        "EngineAssociation": engine_association,
        "FileVersion": 3,
        "Plugins": [
            {"Enabled": True, "Name": "UnrealEditorWebUI"},
            {"Enabled": True, "Name": "AssetToolsFixture", "Optional": True},
            {"Enabled": True, "Name": "LevelToolsFixture", "Optional": True},
        ],
    }
    with tempfile.TemporaryDirectory(
        prefix=".uewebui-rez-host-", dir=parent
    ) as temporary:
        stage = Path(temporary) / project_directory.name
        stage.mkdir()
        project = stage / "RezExternalHost.uproject"
        with project.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(
                json.dumps(descriptor, ensure_ascii=False, indent=2, sort_keys=True)
                + "\n"
            )
        if (stage / "Plugins").exists():
            raise RuntimeError("External Rez host unexpectedly contains a Plugins directory.")
        os.rename(stage, project_directory)
    return project_directory / "RezExternalHost.uproject"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--engine-association", required=True)
    args = parser.parse_args()
    project = create_project(Path(args.project_dir), args.engine_association)
    print(project.resolve(strict=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
