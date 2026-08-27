from __future__ import annotations

from typing import Any, Callable


SDK_API_VERSION = 1

CommandHandler = Callable[[dict[str, Any]], Any]


class CommandExecutionError(RuntimeError):
    """A stable command failure that can be returned through the WebUI bridge."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: list[str] | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details
        self.data = data


def command(
    name: str,
    *,
    description: str = "",
    permission: str = "read",
    schema: dict[str, Any] | None = None,
    supports_dry_run: bool = False,
    execution_thread: str = "editor_game_thread",
    cancellation_mode: str = "queued_only",
    timeout_policy: str = "none",
    category: str = "",
    icon: str = "",
    tags: list[str] | None = None,
    order: int = 100,
    supported_asset_types: list[str] | None = None,
    ui: dict[str, Any] | None = None,
    result_type: str = "json",
    warnings: list[str] | None = None,
) -> Callable[[CommandHandler], CommandHandler]:
    """Register a trusted command with the active Unreal Editor WebUI registry."""

    # Import lazily so the SDK can define the public error type while the registry
    # itself is importing. Decorators run only after the registry registration
    # function has been defined.
    from unreal_editor_webui_registry import _sdk_command as register_command

    return register_command(
        name,
        description=description,
        permission=permission,
        schema=schema,
        supports_dry_run=supports_dry_run,
        execution_thread=execution_thread,
        cancellation_mode=cancellation_mode,
        timeout_policy=timeout_policy,
        category=category,
        icon=icon,
        tags=tags,
        order=order,
        supported_asset_types=supported_asset_types,
        ui=ui,
        result_type=result_type,
        warnings=warnings,
    )


__all__ = [
    "CommandExecutionError",
    "SDK_API_VERSION",
    "command",
]
