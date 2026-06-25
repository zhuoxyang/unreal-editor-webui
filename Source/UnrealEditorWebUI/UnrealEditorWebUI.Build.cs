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
                "CoreUObject"
            }
        );

        PrivateDependencyModuleNames.AddRange(
            new[]
            {
                "ApplicationCore",
                "DeveloperSettings",
                "Engine",
                "HTTP",
                "InputCore",
                "Json",
                "LevelEditor",
                "Projects",
                "PythonScriptPlugin",
                "Slate",
                "SlateCore",
                "ToolMenus",
                "UnrealEd",
                "WebBrowser",
                "WebBrowserWidget"
            }
        );
    }
}
