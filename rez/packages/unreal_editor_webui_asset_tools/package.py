name = "unreal_editor_webui_asset_tools"
version = "1.0.0"
description = "Independent content-only Asset Tools Tool Pack example."
authors = ["zhuoxyang"]

requires = [
    "unreal_editor_webui==0.2.0",
]

build_command = 'rez-python "{root}/build.py"'

tests = {
    "payload": "uewebui-rez-verify --package unreal_editor_webui_asset_tools",
}


def commands():
    env.UE_ADDITIONAL_PLUGIN_PATHS.append("{root}/Plugins")
    env.UNREAL_EDITOR_WEBUI_ASSET_TOOLS_ROOT = "{root}/Plugins/AssetToolsFixture"
    env.UNREAL_EDITOR_WEBUI_ASSET_TOOLS_REZ_RECEIPT = "{root}/RezPayload.json"
