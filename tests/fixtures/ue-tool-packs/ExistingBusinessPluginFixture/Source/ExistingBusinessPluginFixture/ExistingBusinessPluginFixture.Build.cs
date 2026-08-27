using UnrealBuildTool;

public class ExistingBusinessPluginFixture : ModuleRules
{
    public ExistingBusinessPluginFixture(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PrivateDependencyModuleNames.Add("Core");
    }
}
