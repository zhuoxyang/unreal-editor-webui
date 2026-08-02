"""Packaged UE smoke for Web assets.

Run this with UnrealEditor-Cmd after scripts/create-host-project.ps1 has copied a
BuildPlugin artifact into the temporary host project. The native automation test
``UnrealEditorWebUI.Bridge.PackagedRegistryPing`` owns the C++ -> real Python
registry check because production bridge methods are intentionally not exported
as Blueprint/Python-callable APIs. Neither test claims to drive CEF or prove the
JavaScript BindUObject/DOM-event behavior; that last browser hop requires an
interactive GUI-capable UE automation runner.
"""

from __future__ import annotations

import json
import os
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlparse

import unreal


RESULT_ENVIRONMENT_VARIABLE = "UNREAL_WEBUI_PACKAGED_SMOKE_RESULT"


class _FrontendAssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.assets: list[str] = []
        self.module_scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "script" and attributes.get("src"):
            self.assets.append(attributes["src"] or "")
            if (attributes.get("type") or "").lower() == "module":
                self.module_scripts.append(attributes["src"] or "")
        elif tag == "link" and "stylesheet" in (attributes.get("rel") or "").split():
            if attributes.get("href"):
                self.assets.append(attributes["href"] or "")


def _write_result(result: dict[str, object]) -> None:
    output_path = os.environ.get(RESULT_ENVIRONMENT_VARIABLE, "").strip()
    if not output_path:
        return

    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


def _validate_frontend(plugin_directory: Path) -> list[str]:
    dist_directory = (plugin_directory / "Web" / "dist").resolve()
    index_path = dist_directory / "index.html"
    if not index_path.is_file():
        raise RuntimeError(f"Packaged React entry point is missing: {index_path}")

    parser = _FrontendAssetParser()
    parser.feed(index_path.read_text(encoding="utf-8"))
    if not parser.assets:
        raise RuntimeError("Packaged React entry point did not reference any script or stylesheet assets.")
    if parser.module_scripts:
        raise RuntimeError(
            "Packaged React entry point uses module scripts that Chromium blocks under file://: "
            + ", ".join(parser.module_scripts)
        )

    validated_assets: list[str] = []
    for asset_reference in parser.assets:
        parsed = urlparse(asset_reference)
        if parsed.scheme or parsed.netloc:
            raise RuntimeError(f"Packaged frontend references a non-local asset: {asset_reference}")

        relative_path = unquote(parsed.path).lstrip("/")
        asset_path = (dist_directory / relative_path).resolve()
        try:
            asset_path.relative_to(dist_directory)
        except ValueError as error:
            raise RuntimeError(f"Packaged frontend asset escapes Web/dist: {asset_reference}") from error

        if not asset_path.is_file():
            raise RuntimeError(f"Packaged frontend asset is missing: {asset_path}")
        validated_assets.append(asset_path.relative_to(dist_directory).as_posix())

    return validated_assets


def main() -> None:
    project_plugins_directory = Path(
        unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_plugins_dir())
    )
    plugin_directory = project_plugins_directory / "UnrealEditorWebUI"
    if not plugin_directory.is_dir():
        raise RuntimeError(f"Packaged UnrealEditorWebUI plugin is missing: {plugin_directory}")

    assets = _validate_frontend(plugin_directory)
    result = {
        "schemaVersion": 1,
        "ok": True,
        "scope": {
            "packagedFrontendAssets": True,
            "cppToPythonRegistry": False,
            "cefBrowserToBindUObject": False,
            "taskDomEventDelivery": False,
        },
        "validatedAssets": assets,
    }
    _write_result(result)
    unreal.log(
        "Unreal Editor WebUI packaged frontend smoke passed. "
        "The native automation suite owns the C++ to Python registry ping; CEF browser "
        "binding and DOM-event delivery remain outside this commandlet smoke."
    )


try:
    main()
except Exception as error:
    _write_result(
        {
            "schemaVersion": 1,
            "ok": False,
            "error": str(error),
            "scope": {
                "cefBrowserToBindUObject": False,
                "taskDomEventDelivery": False,
            },
        }
    )
    unreal.log_error(f"Unreal Editor WebUI packaged bridge smoke failed: {error}")
    raise
