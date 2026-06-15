#pragma once

#include "CoreMinimal.h"
#include "HAL/CriticalSection.h"
#include "UObject/Object.h"
#include "UnrealEditorWebUIBridge.generated.h"

struct FUnrealEditorWebUITask
{
    FString RequestJson;
    FString ResponseJson;
    FString Status;
    FDateTime CreatedAt;
    FDateTime UpdatedAt;
};

UCLASS()
class UNREALEDITORWEBUI_API UUnrealEditorWebUIBridge : public UObject
{
    GENERATED_BODY()

public:
    UFUNCTION()
    void PostMessage(const FString& Payload);

    UFUNCTION()
    FString ExecuteCommand(const FString& RequestJson);

    UFUNCTION()
    FString StartCommand(const FString& RequestJson);

    UFUNCTION()
    FString GetTask(const FString& TaskId) const;

    UFUNCTION()
    FString RemoveTask(const FString& TaskId);

    UFUNCTION()
    FString GetWebUISettings() const;

    UFUNCTION()
    FString SetWebUISettings(const FString& SettingsJson);

private:
    void RunTask(const FString TaskId, const FString RequestJson);
    void UpdateTaskStatus(const FString& TaskId, const FString& Status, const FString& ResponseJson = FString());

private:
    mutable FCriticalSection TasksCriticalSection;
    TMap<FString, FUnrealEditorWebUITask> Tasks;
};
