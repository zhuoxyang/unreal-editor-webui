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
    static_cast<void>(Parameters);
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

    TestTrue(
        TEXT("Runtime navigation within the configured origin is allowed"),
        UnrealEditorWebUISettings::IsBridgeURLAllowedForStartupScope(
            TEXT("http://127.0.0.1:5173/tools?tab=assets#result"),
            TEXT("http://127.0.0.1:5173/"),
            Error));
    TestTrue(
        TEXT("An omitted default port matches the configured Web origin"),
        UnrealEditorWebUISettings::IsBridgeURLAllowedForStartupScope(
            TEXT("http://localhost/tools"),
            TEXT("http://localhost:80/"),
            Error));
    TestFalse(
        TEXT("A different loopback port cannot inherit the bridge"),
        UnrealEditorWebUISettings::IsBridgeURLAllowedForStartupScope(
            TEXT("http://127.0.0.1:5174/"),
            TEXT("http://127.0.0.1:5173/"),
            Error));
    TestFalse(
        TEXT("A different loopback hostname cannot inherit the bridge"),
        UnrealEditorWebUISettings::IsBridgeURLAllowedForStartupScope(
            TEXT("http://localhost:5173/"),
            TEXT("http://127.0.0.1:5173/"),
            Error));
    TestFalse(
        TEXT("Packaged content cannot navigate into a loopback bridge scope"),
        UnrealEditorWebUISettings::IsBridgeURLAllowedForStartupScope(
            TEXT("http://127.0.0.1:5173/"),
            MakeFileURL(FPaths::Combine(WebDir, TEXT("index.html"))),
            Error));
    TestFalse(
        TEXT("Malformed loopback ports are rejected"),
        UnrealEditorWebUISettings::IsBridgeURLAllowed(TEXT("http://127.0.0.1:not-a-port"), Error));
    TestFalse(
        TEXT("URL user info cannot disguise a loopback authority"),
        UnrealEditorWebUISettings::IsBridgeURLAllowed(TEXT("http://attacker@127.0.0.1:5173"), Error));
    TestFalse(
        TEXT("Whitespace is rejected inside a loopback authority"),
        UnrealEditorWebUISettings::IsBridgeURLAllowed(TEXT("http://127.0.0.1 :5173"), Error));

    return true;
}

#endif
