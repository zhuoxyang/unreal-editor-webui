name = "unreal_editor_webui_project"
version = "1.0.0"
description = "Project aggregate pin for the core and two independent Tool Packs."
authors = ["zhuoxyang"]

variants = [
    [
        "platform-windows",
        "arch-AMD64",
        "unreal_engine==5.4.4",
        "unreal_editor_webui==0.3.0",
        "unreal_editor_webui_asset_tools==1.0.0",
        "unreal_editor_webui_level_tools==1.0.0",
    ],
    [
        "platform-windows",
        "arch-AMD64",
        "unreal_engine==5.5.4",
        "unreal_editor_webui==0.3.0",
        "unreal_editor_webui_asset_tools==1.0.0",
        "unreal_editor_webui_level_tools==1.0.0",
    ],
    [
        "platform-windows",
        "arch-AMD64",
        "unreal_engine==5.8.0",
        "unreal_editor_webui==0.3.0",
        "unreal_editor_webui_asset_tools==1.0.0",
        "unreal_editor_webui_level_tools==1.0.0",
    ],
]

build_command = False

tests = {
    "core-payload": "uewebui-rez-verify --package unreal_editor_webui",
    "asset-tools-payload": "uewebui-rez-verify --package unreal_editor_webui_asset_tools",
    "level-tools-payload": "uewebui-rez-verify --package unreal_editor_webui_level_tools",
}


def commands():
    env.UNREAL_EDITOR_WEBUI_REZ_AGGREGATE = "1.0.0"
