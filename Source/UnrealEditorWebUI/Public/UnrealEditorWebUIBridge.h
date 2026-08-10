#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "HAL/CriticalSection.h"
#include "Templates/Function.h"
#include "UObject/Object.h"
#include "UnrealEditorWebUIBridge.generated.h"

struct FUnrealEditorWebUITask
{
    FString SessionId;
    FString CommandName;
    FString RequestJson;
    FString ResponseJson;
    FString Status;
    FString ExecutionThread;
    FString CancellationMode;
    FString TimeoutPolicy;
    FString PermissionPolicyJson;
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
    void BeginDocumentSession(const FString& SecurityScope);
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

    UFUNCTION()
    FString GetWebUIHealth() const;

    UFUNCTION()
    FString GetProjectContext() const;

    UFUNCTION()
    FString GetToolCatalog() const;

#if WITH_DEV_AUTOMATION_TESTS
    FString TestOnlyCreateTask(
        const FString& RequestJson,
        const FString& Status,
        const FString& ExecutionThread,
        const FString& CancellationMode,
        const FString& TimeoutPolicy,
        const FDateTime& CreatedAt,
        int32 Progress = 0,
        int32 CooperativeTotalSteps = 0);
    bool TestOnlyTickCooperativeTasks(float DeltaTime);
    FString TestOnlyValidatePreflightResponse(
        const FString& RequestId,
        const FString& PreflightJson) const;
    FString TestOnlyBuildProjectStorageNamespace(const FString& ProjectIdentity) const;
    FString TestOnlyBuildWebUIHealthResponse(
        const FString& PluginVersion,
        bool bPythonAvailable) const;
    FString TestOnlyGetToolCatalogFromProjectConfigDir(const FString& ProjectConfigDir) const;
    void TestOnlyCompleteTaskWithResponse(
        const FString& TaskId,
        const FString& ResponseJson,
        const FString& LogLine = TEXT("Task completed."));
    bool TestOnlySetTaskCreatedAt(const FString& TaskId, const FDateTime& CreatedAt);
    void TestOnlyRunTask(
        const FString& TaskId,
        const FString& RequestJson,
        const FString& PermissionPolicyJson = TEXT("{}"));
    void TestOnlySetPrivilegedCommandConfirmation(
        TFunction<bool(const FString&, const FString&, const FString&)> InConfirmation);
    FString TestOnlyBuildPrivilegedCommandMessage(
        const FString& CommandName,
        const FString& Permission,
        const FString& PayloadSummary) const;
    int32 TestOnlyStoredTaskCount() const;
#endif

private:
    void RunTask(const FString TaskId, const FString RequestJson, const FString PermissionPolicyJson);
    void UpdateTaskStatus(
        const FString& TaskId,
        const FString& Status,
        const FString& ResponseJson = FString(),
        int32 Progress = INDEX_NONE,
        const FString& LogLine = FString());
    void BroadcastTaskEvent(
        const FString& TaskId,
        const FString& Status,
        int32 Progress = INDEX_NONE,
        const FString& LogLine = FString());
    FString ExecuteRegistryFunction(
        const FString& RequestJson,
        const FString& FunctionName,
        const FString& PermissionPolicyJson = FString()) const;
    bool ConfirmPrivilegedCommand(
        const FString& CommandName,
        const FString& Permission,
        const FString& PayloadSummary) const;
    void PruneTasksLocked(const FDateTime& Now);
    void EnforceTaskResponseBudgetLocked(const FString& PreserveTaskId);
    void StartCooperativeTask(
        const FString& TaskId,
        const FString& RequestJson,
        const FString& PermissionPolicyJson);
    bool TickCooperativeTasks(float DeltaTime);
    void EnsureCooperativeTicker();
    void StopCooperativeTickerIfIdle();
    bool IsTaskVisibleInCurrentSessionLocked(const FUnrealEditorWebUITask& Task) const;
    void CancelAllCooperativeCommands() const;

private:
    mutable FCriticalSection TasksCriticalSection;
    TMap<FString, FUnrealEditorWebUITask> Tasks;
    FString CurrentDocumentSessionId = TEXT("initial-session");
    FString CurrentDocumentScope = TEXT("inactive");
    TFunction<void(const FString&)> EventDispatcher;
    FTSTicker::FDelegateHandle CooperativeTaskTickerHandle;
#if WITH_DEV_AUTOMATION_TESTS
    TFunction<bool(const FString&, const FString&, const FString&)> TestPrivilegedCommandConfirmation;
#endif
};
