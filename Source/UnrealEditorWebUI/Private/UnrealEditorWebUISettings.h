#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "UnrealEditorWebUISettings.generated.h"

struct FUnrealEditorWebUISettings
{
    bool bUseDevServer = false;
    FString DevServerURL = TEXT("http://localhost:5173");
    FString StartupURL;
};

UCLASS(Config=EditorPerProjectUserSettings, DefaultConfig, meta=(DisplayName="Unreal Editor WebUI"))
class UNREALEDITORWEBUI_API UUnrealEditorWebUIEditorSettings : public UDeveloperSettings
{
    GENERATED_BODY()

public:
    UPROPERTY(Config, EditAnywhere, Category="Startup", meta=(DisplayName="Use Dev Server"))
    bool bUseDevServer = false;

    UPROPERTY(Config, EditAnywhere, Category="Startup", meta=(DisplayName="Dev Server URL"))
    FString DevServerURL = TEXT("http://localhost:5173");

    UPROPERTY(Config, EditAnywhere, Category="Startup", meta=(DisplayName="Startup URL"))
    FString StartupURL;

#if WITH_EDITOR
    virtual FName GetContainerName() const override;
    virtual FName GetCategoryName() const override;
    virtual FName GetSectionName() const override;
    virtual FText GetSectionText() const override;
    virtual FText GetSectionDescription() const override;
    virtual void PostEditChangeProperty(FPropertyChangedEvent& PropertyChangedEvent) override;
#endif

    virtual void PostInitProperties() override;

    FUnrealEditorWebUISettings ToRuntimeSettings() const;
    void ApplyRuntimeSettings(const FUnrealEditorWebUISettings& Settings);
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
