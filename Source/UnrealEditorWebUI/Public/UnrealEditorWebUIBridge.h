#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "HAL/CriticalSection.h"
#include "Templates/Function.h"
#include "UObject/Object.h"
#include "UnrealEditorWebUIBridge.generated.h"

struct FUnrealEditorWebUITask
{
    FString RequestJson;
    FString ResponseJson;
    FString Status;
    FString ExecutionThread;
    FString CancellationMode;
    FString TimeoutPolicy;
    FString StatusMessage;
    int32 Progress = 0;
    int32 CooperativeStep = 0;
    int32 CooperativeTotalSteps = 0;
    bool bCancellable = false;
    bool bCancellationRequested = false;
    TArray<FString> Logs;
    FDateTime CreatedAt;
    FDateTime UpdatedAt;
};

UCLASS()
class UNREALEDITORWEBUI_API UUnrealEditorWebUIBridge : public UObject
{
    GENERATED_BODY()

public:
    void SetEventDispatcher(TFunction<void(const FString&)> InEventDispatcher);
    void ResetPrivilegedCommandApprovals();

    UFUNCTION()
    void PostMessage(const FString& Payload);

    UFUNCTION()
    FString ExecuteCommand(const FString& RequestJson);

    UFUNCTION()
    FString StartCommand(const FString& RequestJson);

    UFUNCTION()
    FString GetTask(const FString& TaskId) const;

    UFUNCTION()
    FString ListTasks() const;

    UFUNCTION()
    FString RemoveTask(const FString& TaskId);

    UFUNCTION()
    FString CancelTask(const FString& TaskId);

    UFUNCTION()
    FString GetWebUISettings() const;

    UFUNCTION()
    FString SetWebUISettings(const FString& SettingsJson);

private:
    void RunTask(const FString TaskId, const FString RequestJson);
    void UpdateTaskStatus(
        const FString& TaskId,
        const FString& Status,
        const FString& ResponseJson = FString(),
        int32 Progress = INDEX_NONE,
        const FString& LogLine = FString());
    void BroadcastTaskEvent(
        const FString& TaskId,
        const FString& Status,
        const FString& ResponseJson = FString(),
        int32 Progress = INDEX_NONE,
        const FString& LogLine = FString());
    FString ExecuteRegistryFunction(
        const FString& RequestJson,
        const FString& FunctionName,
        const FString& PermissionPolicyJson = FString()) const;
    bool ConfirmPrivilegedCommand(
        const FString& CommandName,
        const FString& Permission,
        bool bAllowReusableApproval = true) const;
    bool HasPrivilegedCommandApproval(const FString& CommandName, const FString& Permission) const;
    void GrantPrivilegedCommandApproval(const FString& CommandName, const FString& Permission);
    void PruneTasksLocked(const FDateTime& Now);
    void StartCooperativeTask(const FString& TaskId, const FString& RequestJson);
    bool TickCooperativeTasks(float DeltaTime);
    void EnsureCooperativeTicker();
    void StopCooperativeTickerIfIdle();

private:
    mutable FCriticalSection TasksCriticalSection;
    TMap<FString, FUnrealEditorWebUITask> Tasks;
    mutable FCriticalSection PrivilegedCommandApprovalsCriticalSection;
    TSet<FString> PrivilegedCommandApprovals;
    TFunction<void(const FString&)> EventDispatcher;
    FTSTicker::FDelegateHandle CooperativeTaskTickerHandle;
};
