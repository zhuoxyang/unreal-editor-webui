from __future__ import annotations

from dataclasses import dataclass, field
from contextlib import nullcontext
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
    changed_unsaved: list[dict[str, Any]] = field(default_factory=list)
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

    def mark_changed_unsaved(self, operation: ChangeOperation, message: str) -> None:
        operation.status = "changed_unsaved"
        operation.message = message
        self.changed_unsaved.append(operation.to_dict())

    def to_result(self) -> dict[str, Any]:
        if self.dry_run:
            status = "preview"
        elif self.changed_unsaved or (self.changed and self.failed):
            status = "partial"
        elif self.failed and not self.changed:
            status = "failed"
        elif self.changed:
            status = "completed"
        else:
            status = "no_changes"

        return {
            "protocolVersion": 1,
            "view": "changeSet",
            "summary": {
                "label": self.label,
                "dryRun": self.dry_run,
                "save": self.save,
                "status": status,
                "changed": len(self.changed),
                "changedUnsaved": len(self.changed_unsaved),
                "skipped": len(self.skipped),
                "failed": len(self.failed),
                "total": len(self.operations),
            },
            "changeSet": [operation.to_dict() for operation in self.operations],
            "changed": self.changed,
            "changedUnsaved": self.changed_unsaved,
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
    from unreal_editor_webui_registry import CommandExecutionError

    session = WriteSession("asset.renameBatch", dry_run=dry_run, save=save)
    library = _editor_asset_library()
    planned_operations: list[tuple[ChangeOperation, str]] = []
    seen_sources: set[str] = set()
    seen_targets: set[str] = set()

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

        if asset_path in seen_sources:
            session.fail(operation, "Duplicate source asset path in this batch.")
            continue
        seen_sources.add(asset_path)

        if target_path in seen_targets:
            session.fail(operation, "Multiple source assets resolve to the same target path.")
            continue
        seen_targets.add(target_path)

        if library is not None:
            does_asset_exist = getattr(library, "does_asset_exist", None)
            if callable(does_asset_exist) and bool(does_asset_exist(target_path)):
                session.fail(operation, "Target asset path already exists.")
                continue

        if dry_run:
            session.mark_changed(operation, "Dry-run preview only; no asset was modified.")
            continue

        if library is None:
            session.fail(operation, "EditorAssetLibrary is unavailable.")
            continue

        planned_operations.append((operation, target_path))

    transaction_type = getattr(unreal, "ScopedEditorTransaction", None)
    transaction = (
        transaction_type(f"UnrealEditorWebUI {session.label}")
        if transaction_type is not None and planned_operations
        else nullcontext()
    )

    with transaction:
        for operation, target_path in planned_operations:
            asset_path = operation.asset_path

            checkout_ok, checkout_message = _checkout_asset(asset_path)
            if not checkout_ok:
                session.fail(operation, checkout_message)
                continue

            rename_asset = getattr(library, "rename_asset", None)
            if not callable(rename_asset):
                session.fail(operation, "EditorAssetLibrary.rename_asset is unavailable.")
                continue

            try:
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
                    session.mark_changed_unsaved(
                        operation,
                        f"Asset was renamed but could not be saved: {save_message}",
                    )
                    continue

            session.mark_changed(operation, checkout_message)

    result = session.to_result()
    summary = result["summary"]
    if (
        not dry_run
        and summary["failed"] > 0
        and summary["changed"] == 0
        and summary["changedUnsaved"] == 0
    ):
        raise CommandExecutionError(
            "batch_failed",
            "No asset in the rename batch could be changed.",
            data={
                "protocolVersion": result["protocolVersion"],
                "view": result["view"],
                "summary": result["summary"],
                "changeSet": result["changeSet"],
            },
        )

    return result
