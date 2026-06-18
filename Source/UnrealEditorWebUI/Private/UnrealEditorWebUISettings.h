#pragma once

#include "CoreMinimal.h"

struct FUnrealEditorWebUISettings
{
    bool bUseDevServer = false;
    FString DevServerURL = TEXT("http://localhost:5173");
    FString StartupURL;
};

namespace UnrealEditorWebUISettings
{
    FUnrealEditorWebUISettings Load();
    void Save(const FUnrealEditorWebUISettings& Settings);
    FString ResolveStartupURL();
    FString ToJson(const FUnrealEditorWebUISettings& Settings);
    bool FromJson(const FString& SettingsJson, FUnrealEditorWebUISettings& OutSettings, FString& OutError);
    bool IsBridgeURLAllowed(const FString& URL, FString& OutError);
}
