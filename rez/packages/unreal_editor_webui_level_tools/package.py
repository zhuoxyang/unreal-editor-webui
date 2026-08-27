name = "unreal_editor_webui_level_tools"
version = "1.0.0"
description = "Independent content-only Level Tools Tool Pack example."
authors = ["zhuoxyang"]

requires = [
    "unreal_editor_webui==0.3.0",
]

build_command = 'rez-python "{root}/build.py"'

tests = {
    "payload": "uewebui-rez-verify --package unreal_editor_webui_level_tools",
}


def commands():
    env.UE_ADDITIONAL_PLUGIN_PATHS.append("{root}/Plugins")
    env.UNREAL_EDITOR_WEBUI_LEVEL_TOOLS_ROOT = "{root}/Plugins/LevelToolsFixture"
    env.UNREAL_EDITOR_WEBUI_LEVEL_TOOLS_REZ_RECEIPT = "{root}/RezPayload.json"
