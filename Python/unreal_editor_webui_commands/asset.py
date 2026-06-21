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


def _issue(severity: str, asset_path: str, message: str, suggested_action: str, property_path: str = "") -> dict[str, str]:
    return {
        "severity": severity,
        "assetPath": asset_path,
        "propertyPath": property_path,
        "message": message,
        "suggestedAction": suggested_action,
    }


def _asset_name_from_path(asset_path: str) -> str:
    return asset_path.rsplit("/", 1)[-1].split(".", 1)[0]


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
    "asset.validateNaming",
    description="Validate starter asset naming prefixes and path casing.",
    permission="read",
    schema={
        "type": "object",
        "properties": {
            "assetPaths": {
                "type": "array",
                "description": "Asset paths to validate.",
                "items": {"type": "string", "minLength": 1, "maxLength": 1024},
                "minItems": 1,
                "maxItems": 500,
                "default": ["/Game/Props/Chair"],
            },
            "allowedPrefixes": {
                "type": "array",
                "description": "Allowed asset name prefixes.",
                "items": {"type": "string", "minLength": 1, "maxLength": 32},
                "default": ["SM_", "SK_", "M_", "MI_", "T_", "BP_"],
            },
        },
        "additionalProperties": False,
    },
    category="Assets",
    icon="check-circle",
    tags=["asset", "validation", "naming", "art", "ta"],
    order=30,
    result_type="issueTable",
)
def validate_naming(payload: dict[str, Any]) -> dict[str, Any]:
    allowed_prefixes = [str(prefix) for prefix in payload.get("allowedPrefixes", [])]
    issues: list[dict[str, str]] = []

    for asset_path in [str(path) for path in payload.get("assetPaths", [])]:
        asset_name = _asset_name_from_path(asset_path)
        if not any(asset_name.startswith(prefix) for prefix in allowed_prefixes):
            issues.append(
                _issue(
                    "warning",
                    asset_path,
                    f'Asset "{asset_name}" does not use an approved prefix.',
                    f"Rename the asset to start with one of: {', '.join(allowed_prefixes)}.",
                    "name",
                )
            )

        if " " in asset_path or asset_path != asset_path.strip():
            issues.append(
                _issue(
                    "blocker",
                    asset_path,
                    "Asset path contains whitespace.",
                    "Remove spaces from the package path and asset name.",
                    "path",
                )
            )

    return {
        "protocolVersion": 1,
        "view": "issueTable",
        "summary": {
            "checked": len(payload.get("assetPaths", [])),
            "issues": len(issues),
        },
        "issues": issues,
    }


@command(
    "asset.validateTextureBudget",
    description="Validate texture asset sizes against a simple platform budget.",
    permission="read",
    schema={
        "type": "object",
        "properties": {
            "textures": {
                "type": "array",
                "description": "Texture records with path, width, and height.",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "minLength": 1, "maxLength": 1024},
                        "width": {"type": "integer", "minimum": 1, "maximum": 32768},
                        "height": {"type": "integer", "minimum": 1, "maximum": 32768},
                    },
                    "required": ["path", "width", "height"],
                    "additionalProperties": False,
                },
                "default": [],
            },
            "maxSize": {
                "type": "integer",
                "description": "Maximum allowed width or height.",
                "default": 4096,
                "minimum": 1,
                "maximum": 32768,
            },
        },
        "additionalProperties": False,
    },
    category="Materials",
    icon="image",
    tags=["asset", "texture", "budget", "art", "ta", "release"],
    order=40,
    result_type="issueTable",
)
def validate_texture_budget(payload: dict[str, Any]) -> dict[str, Any]:
    max_size = int(payload.get("maxSize", 4096))
    issues: list[dict[str, str]] = []

    for texture in payload.get("textures", []):
        path = str(texture.get("path", ""))
        width = int(texture.get("width", 0))
        height = int(texture.get("height", 0))
        if width > max_size or height > max_size:
            issues.append(
                _issue(
                    "warning",
                    path,
                    f"Texture is {width}x{height}, over the {max_size}px budget.",
                    "Resize, stream, or move the texture into an approved exception list.",
                    "texture.size",
                )
            )

    return {
        "protocolVersion": 1,
        "view": "issueTable",
        "summary": {
            "checked": len(payload.get("textures", [])),
            "issues": len(issues),
            "maxSize": max_size,
        },
        "issues": issues,
    }


@command(
    "asset.scanRedirectors",
    description="Report redirector-like asset paths that should be fixed up.",
    permission="read",
    schema={
        "type": "object",
        "properties": {
            "assetPaths": {
                "type": "array",
                "description": "Asset paths to inspect for redirector naming patterns.",
                "items": {"type": "string", "minLength": 1, "maxLength": 1024},
                "default": [],
            },
        },
        "additionalProperties": False,
    },
    category="Release",
    icon="git-branch",
    tags=["asset", "redirector", "release", "ta"],
    order=50,
    result_type="issueTable",
)
def scan_redirectors(payload: dict[str, Any]) -> dict[str, Any]:
    issues = [
        _issue(
            "warning",
            str(asset_path),
            "Potential redirector asset detected.",
            "Run Fix Up Redirectors in the Content Browser before release.",
            "asset.class",
        )
        for asset_path in payload.get("assetPaths", [])
        if "redirector" in str(asset_path).lower()
    ]

    return {
        "protocolVersion": 1,
        "view": "issueTable",
        "summary": {
            "checked": len(payload.get("assetPaths", [])),
            "issues": len(issues),
        },
        "issues": issues,
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
