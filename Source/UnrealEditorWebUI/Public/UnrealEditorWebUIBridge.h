#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "UnrealEditorWebUIBridge.generated.h"

UCLASS()
class UNREALEDITORWEBUI_API UUnrealEditorWebUIBridge : public UObject
{
    GENERATED_BODY()

public:
    UFUNCTION()
    void PostMessage(const FString& Payload);

    UFUNCTION()
    FString GetProjectName() const;

    UFUNCTION()
    FString GetProjectDir() const;

    UFUNCTION()
    bool ExecutePython(const FString& PythonCode);
};
