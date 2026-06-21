from __future__ import annotations

from typing import Any

import unreal

from unreal_editor_webui_registry import command


def _asset_data_to_dict(asset_data: Any) -> dict[str, str]:
    return {
        "assetName": str(getattr(asset_data, "asset_name", "")),
        "packageName": str(getattr(asset_data, "package_name", "")),
        "packagePath": str(getattr(asset_data, "package_path", "")),
        "objectPath": str(getattr(asset_data, "object_path", "")),
        "assetClass": str(getattr(asset_data, "asset_class_path", getattr(asset_data, "asset_class", ""))),
    }


@command(
    "asset.listByPath",
    description="List assets under a content path using the Asset Registry.",
    permission="read",
    schema={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Content path, for example /Game",
                "minLength": 1,
                "maxLength": 512,
                "default": "/Game",
            },
            "recursive": {
                "type": "boolean",
                "description": "Include child folders.",
                "default": True,
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of assets to return.",
                "default": 50,
                "minimum": 1,
                "maximum": 500,
            },
        },
        "required": ["path"],
        "additionalProperties": False,
    },
    category="Assets",
    icon="database",
    tags=["asset", "browser"],
    order=10,
    result_type="assetTable",
)
def list_assets_by_path(payload: dict[str, Any]) -> dict[str, Any]:
    path = str(payload.get("path", "/Game"))
    recursive = bool(payload.get("recursive", True))
    limit = int(payload.get("limit", 50))
    limit = max(1, min(limit, 500))

    asset_registry = unreal.AssetRegistryHelpers.get_asset_registry()
    asset_data_items = asset_registry.get_assets_by_path(path, recursive)
    assets = [_asset_data_to_dict(asset_data) for asset_data in asset_data_items[:limit]]

    return {
        "path": path,
        "recursive": recursive,
        "count": len(assets),
        "truncated": len(asset_data_items) > limit,
        "assets": assets,
    }


@command(
    "asset.renameBatch",
    description="Preview or apply a batch asset rename operation.",
    permission="write",
    schema={
        "type": "object",
        "properties": {
            "assetPaths": {
                "type": "array",
                "description": "Asset object paths to rename.",
                "items": {"type": "string", "minLength": 1, "maxLength": 1024},
                "minItems": 1,
                "maxItems": 200,
            },
            "search": {
                "type": "string",
                "description": "Text to replace in each asset path.",
                "minLength": 1,
                "maxLength": 128,
            },
            "replace": {
                "type": "string",
                "description": "Replacement text.",
                "maxLength": 128,
            },
            "dryRun": {
                "type": "boolean",
                "description": "Preview changes without modifying assets.",
                "default": True,
                "xDryRun": True,
            },
            "save": {
                "type": "boolean",
                "description": "Save renamed assets after applying changes.",
                "default": False,
            },
        },
        "required": ["assetPaths", "search", "replace"],
        "additionalProperties": False,
    },
    supports_dry_run=True,
    category="Assets",
    icon="edit-3",
    tags=["asset", "rename", "dry-run"],
    order=20,
    result_type="changeSet",
)
def rename_assets_batch(payload: dict[str, Any]) -> dict[str, Any]:
    from unreal_editor_webui_write import apply_rename_batch

    return apply_rename_batch(
        asset_paths=[str(path) for path in payload.get("assetPaths", [])],
        search=str(payload.get("search", "")),
        replace=str(payload.get("replace", "")),
        dry_run=bool(payload.get("dryRun", True)),
        save=bool(payload.get("save", False)),
    )
