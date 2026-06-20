using UnrealBuildTool;

public class UnrealEditorWebUI : ModuleRules
{
    public UnrealEditorWebUI(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(
            new[]
            {
                "Core",
                "CoreUObject",
                "Engine",
                "Json",
                "Slate",
                "SlateCore",
                "WebBrowser",
                "WebBrowserWidget"
            }
        );

        PrivateDependencyModuleNames.AddRange(
            new[]
            {
                "ApplicationCore",
                "DeveloperSettings",
                "HTTP",
                "InputCore",
                "LevelEditor",
                "Projects",
                "PythonScriptPlugin",
                "ToolMenus",
                "UnrealEd"
            }
        );
    }
}
