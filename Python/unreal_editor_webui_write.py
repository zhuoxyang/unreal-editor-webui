from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import unreal


@dataclass
class ChangeOperation:
    asset_path: str
    property_path: str
    before: Any
    after: Any
    action: str
    status: str = "pending"
    message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "assetPath": self.asset_path,
            "propertyPath": self.property_path,
            "before": self.before,
            "after": self.after,
            "action": self.action,
            "status": self.status,
            "message": self.message,
        }


@dataclass
class WriteSession:
    label: str
    dry_run: bool = True
    save: bool = False
    operations: list[ChangeOperation] = field(default_factory=list)
    changed: list[dict[str, Any]] = field(default_factory=list)
    skipped: list[dict[str, Any]] = field(default_factory=list)
    failed: list[dict[str, Any]] = field(default_factory=list)

    def add_operation(
        self,
        *,
        asset_path: str,
        property_path: str,
        before: Any,
        after: Any,
        action: str,
    ) -> ChangeOperation:
        operation = ChangeOperation(
            asset_path=asset_path,
            property_path=property_path,
            before=before,
            after=after,
            action=action,
        )
        self.operations.append(operation)
        return operation

    def skip(self, operation: ChangeOperation, message: str) -> None:
        operation.status = "skipped"
        operation.message = message
        self.skipped.append(operation.to_dict())

    def fail(self, operation: ChangeOperation, message: str) -> None:
        operation.status = "failed"
        operation.message = message
        self.failed.append(operation.to_dict())

    def mark_changed(self, operation: ChangeOperation, message: str = "") -> None:
        operation.status = "changed"
        operation.message = message
        self.changed.append(operation.to_dict())

    def to_result(self) -> dict[str, Any]:
        return {
            "protocolVersion": 1,
            "view": "changeSet",
            "summary": {
                "label": self.label,
                "dryRun": self.dry_run,
                "save": self.save,
                "changed": len(self.changed),
                "skipped": len(self.skipped),
                "failed": len(self.failed),
                "total": len(self.operations),
            },
            "changeSet": [operation.to_dict() for operation in self.operations],
            "changed": self.changed,
            "skipped": self.skipped,
            "failed": self.failed,
        }


def _editor_asset_library() -> Any | None:
    return getattr(unreal, "EditorAssetLibrary", None)


def _source_control_available() -> bool:
    source_control = getattr(unreal, "SourceControl", None)
    if source_control is None:
        return False
    is_enabled = getattr(source_control, "is_enabled", None)
    return bool(is_enabled()) if callable(is_enabled) else False


def _checkout_asset(asset_path: str) -> tuple[bool, str]:
    if not _source_control_available():
        return True, "Source control unavailable; continuing without checkout."

    source_control = getattr(unreal, "SourceControl")
    checkout = getattr(source_control, "check_out_or_add_file", None)
    if callable(checkout):
        return bool(checkout(asset_path)), "Checked out through source control."

    return False, "Source control is enabled but checkout API is unavailable."


def _save_asset(asset_path: str) -> tuple[bool, str]:
    library = _editor_asset_library()
    if library is None:
        return False, "EditorAssetLibrary is unavailable."

    save_asset = getattr(library, "save_asset", None)
    if not callable(save_asset):
        return False, "EditorAssetLibrary.save_asset is unavailable."

    return bool(save_asset(asset_path, only_if_is_dirty=False)), "Save requested."


def apply_rename_batch(
    *,
    asset_paths: list[str],
    search: str,
    replace: str,
    dry_run: bool = True,
    save: bool = False,
) -> dict[str, Any]:
    session = WriteSession("asset.renameBatch", dry_run=dry_run, save=save)
    library = _editor_asset_library()

    for asset_path in asset_paths:
        target_path = asset_path.replace(search, replace)
        operation = session.add_operation(
            asset_path=asset_path,
            property_path="objectPath",
            before=asset_path,
            after=target_path,
            action="rename",
        )

        if asset_path == target_path:
            session.skip(operation, "Search text was not found in the asset path.")
            continue

        if dry_run:
            session.mark_changed(operation, "Dry-run preview only; no asset was modified.")
            continue

        if library is None:
            session.fail(operation, "EditorAssetLibrary is unavailable.")
            continue

        checkout_ok, checkout_message = _checkout_asset(asset_path)
        if not checkout_ok:
            session.fail(operation, checkout_message)
            continue

        rename_asset = getattr(library, "rename_asset", None)
        if not callable(rename_asset):
            session.fail(operation, "EditorAssetLibrary.rename_asset is unavailable.")
            continue

        transaction = getattr(unreal, "ScopedEditorTransaction", None)
        try:
            if transaction is not None:
                with transaction(f"UnrealEditorWebUI {session.label}"):
                    renamed = bool(rename_asset(asset_path, target_path))
            else:
                renamed = bool(rename_asset(asset_path, target_path))
        except Exception as exc:
            session.fail(operation, str(exc))
            continue

        if not renamed:
            session.fail(operation, "Unreal rejected the asset rename.")
            continue

        if save:
            save_ok, save_message = _save_asset(target_path)
            if not save_ok:
                session.fail(operation, save_message)
                continue

        session.mark_changed(operation, checkout_message)

    return session.to_result()
