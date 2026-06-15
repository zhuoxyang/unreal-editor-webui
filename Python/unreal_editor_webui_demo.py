import unreal


def run_demo_command():
    """Example command callable from the WebUI Python bridge."""
    project_name = unreal.SystemLibrary.get_project_name()
    unreal.log(f"Unreal Editor WebUI Python demo is running in project: {project_name}")
    return project_name
