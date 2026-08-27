using UnrealBuildTool;

public class ExistingCodeToolPackFixture : ModuleRules
{
    public ExistingCodeToolPackFixture(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PrivateDependencyModuleNames.Add("Core");
    }
}
