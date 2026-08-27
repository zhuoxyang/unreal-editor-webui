name = "unreal_editor_webui"
version = "0.2.0"
description = "Immutable precompiled UnrealEditorWebUI core for exact Windows UE variants."
authors = ["zhuoxyang"]

requires = [
    "platform-windows",
    "arch-AMD64",
]

variants = [
    ["unreal_engine==5.4.4"],
    ["unreal_engine==5.5.4"],
    ["unreal_engine==5.8.0"],
]

build_command = 'rez-python "{root}/build.py"'

tools = [
    "uewebui-rez-preflight",
    "uewebui-rez-launch",
    "uewebui-rez-verify",
]

tests = {
    "payload": "uewebui-rez-verify --package unreal_editor_webui",
}


def commands():
    env.UE_ADDITIONAL_PLUGIN_PATHS.append("{root}/Plugins")
    env.UNREAL_EDITOR_WEBUI_ROOT = "{root}/Plugins/UnrealEditorWebUI"
    env.UNREAL_EDITOR_WEBUI_REZ_RECEIPT = "{root}/RezPayload.json"
    env.UNREAL_EDITOR_WEBUI_REZ_TOOL = "{root}/Scripts/rez_payload.py"
    env.PATH.append("{root}/Scripts")
