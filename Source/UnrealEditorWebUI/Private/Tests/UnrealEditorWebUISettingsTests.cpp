#if WITH_DEV_AUTOMATION_TESTS

#include "UnrealEditorWebUISettings.h"

#include "Interfaces/IPluginManager.h"
#include "Misc/AutomationTest.h"
#include "Misc/Paths.h"

namespace
{
    FString MakeFileURL(const FString& Path)
    {
        const FString NormalizedPath = Path.Replace(TEXT("\\"), TEXT("/"));
#if PLATFORM_WINDOWS
        return FString::Printf(TEXT("file:///%s"), *NormalizedPath);
#else
        return FString::Printf(TEXT("file://%s"), *NormalizedPath);
#endif
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUnrealEditorWebUISettingsURLTest,
    "UnrealEditorWebUI.Settings.URLAllowlist",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUnrealEditorWebUISettingsURLTest::RunTest(const FString& Parameters)
{
    UE_UNUSED(Parameters);
    const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("UnrealEditorWebUI"));
    if (!TestTrue(TEXT("Plugin is available"), Plugin.IsValid()))
    {
        return false;
    }

    const FString WebDir = FPaths::ConvertRelativePathToFull(FPaths::Combine(Plugin->GetBaseDir(), TEXT("Web")));
    FString Error;

    TestTrue(
        TEXT("Packaged Web file is allowed"),
        UnrealEditorWebUISettings::IsBridgeURLAllowed(MakeFileURL(FPaths::Combine(WebDir, TEXT("index.html"))), Error));
    TestTrue(
        TEXT("Loopback development URL is allowed"),
        UnrealEditorWebUISettings::IsBridgeURLAllowed(TEXT("http://127.0.0.1:5173"), Error));
    TestFalse(
        TEXT("Remote URL is rejected"),
        UnrealEditorWebUISettings::IsBridgeURLAllowed(TEXT("https://example.com"), Error));
    TestFalse(
        TEXT("Literal parent traversal is rejected"),
        UnrealEditorWebUISettings::IsBridgeURLAllowed(
            MakeFileURL(FPaths::Combine(WebDir, TEXT("../Python/registry.py"))),
            Error));

    FString EncodedTraversalURL = MakeFileURL(FPaths::Combine(WebDir, TEXT("%2e%2e/Python/registry.py")));
    TestFalse(
        TEXT("Encoded parent traversal is rejected"),
        UnrealEditorWebUISettings::IsBridgeURLAllowed(EncodedTraversalURL, Error));

    return true;
}

#endif
