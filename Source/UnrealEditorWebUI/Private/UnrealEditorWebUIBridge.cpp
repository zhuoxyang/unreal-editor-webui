#include "UnrealEditorWebUIBridge.h"
#include "UnrealEditorWebUISettings.h"

#include "Async/Async.h"
#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "IPythonScriptPlugin.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Base64.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/MessageDialog.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

DEFINE_LOG_CATEGORY_STATIC(LogUnrealEditorWebUIBridge, Log, All);

namespace
{
    constexpr int32 MaxStoredTasks = 64;
    constexpr int32 MaxTaskLogLines = 80;

    FString WriteJsonObject(const TSharedRef<FJsonObject>& JsonObject)
    {
        FString Output;
        const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
            TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output);
        FJsonSerializer::Serialize(JsonObject, Writer);
        return Output;
    }

    FString ExtractRequestId(const FString& RequestJson)
    {
        TSharedPtr<FJsonObject> RequestObject;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestJson);

        if (!FJsonSerializer::Deserialize(Reader, RequestObject) || !RequestObject.IsValid())
        {
            return FString();
        }

        FString RequestId;
        RequestObject->TryGetStringField(TEXT("id"), RequestId);
        return RequestId;
    }

    void SetNullableId(const TSharedRef<FJsonObject>& Root, const FString& RequestId)
    {
        if (RequestId.IsEmpty())
        {
            Root->SetField(TEXT("id"), MakeShared<FJsonValueNull>());
        }
        else
        {
            Root->SetStringField(TEXT("id"), RequestId);
        }
    }

    FString MakeErrorResponse(const FString& RequestId, const FString& Code, const FString& Message)
    {
        const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
        SetNullableId(Root, RequestId);
        Root->SetBoolField(TEXT("ok"), false);

        const TSharedRef<FJsonObject> Error = MakeShared<FJsonObject>();
        Error->SetStringField(TEXT("code"), Code);
        Error->SetStringField(TEXT("message"), Message);
        Root->SetObjectField(TEXT("error"), Error);

        return WriteJsonObject(Root);
    }

    FString MakeSuccessResponse(const FString& RequestId, const TSharedRef<FJsonObject>& Result)
    {
        const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
        SetNullableId(Root, RequestId);
        Root->SetBoolField(TEXT("ok"), true);
        Root->SetObjectField(TEXT("result"), Result);
        return WriteJsonObject(Root);
    }

    TSharedRef<FJsonObject> ParseJsonObjectOrEmpty(const FString& Json)
    {
        TSharedPtr<FJsonObject> Object;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
        if (FJsonSerializer::Deserialize(Reader, Object) && Object.IsValid())
        {
            return Object.ToSharedRef();
        }

        return MakeShared<FJsonObject>();
    }

    FString EncodeBase64Utf8(const FString& Value)
    {
        FTCHARToUTF8 Converter(*Value);
        return FBase64::Encode(reinterpret_cast<const uint8*>(Converter.Get()), Converter.Length());
    }

    bool IsFinishedTaskStatus(const FString& Status)
    {
        return Status == TEXT("completed") || Status == TEXT("failed") || Status == TEXT("cancelled");
    }

    void AppendTaskLogLocked(FUnrealEditorWebUITask& Task, const FString& LogLine)
    {
        if (LogLine.IsEmpty())
        {
            return;
        }

        Task.Logs.Add(LogLine);
        while (Task.Logs.Num() > MaxTaskLogLines)
        {
            Task.Logs.RemoveAt(0);
        }
    }

    bool IsPrivilegedPermission(const FString& Permission)
    {
        const FString Normalized = Permission.ToLower();
        return Normalized == TEXT("write") || Normalized == TEXT("destructive");
    }

    FString MakePrivilegedCommandKey(const FString& CommandName, const FString& Permission)
    {
        return FString::Printf(TEXT("%s:%s"), *Permission.ToLower(), *CommandName);
    }

    bool CanReusePrivilegedApproval(const FString& Permission)
    {
        return Permission.ToLower() == TEXT("write");
    }

    FString MakePermissionPolicyJson(const FString& CommandName, const FString& Permission)
    {
        const TSharedRef<FJsonObject> Policy = MakeShared<FJsonObject>();
        Policy->SetStringField(TEXT("allowedCommand"), CommandName);
        Policy->SetStringField(TEXT("allowedPermission"), Permission.ToLower());
        return WriteJsonObject(Policy);
    }
}

void UUnrealEditorWebUIBridge::PostMessage(const FString& Payload)
{
    UE_LOG(LogUnrealEditorWebUIBridge, Log, TEXT("WebUI message: %s"), *Payload);
}

void UUnrealEditorWebUIBridge::SetEventDispatcher(TFunction<void(const FString&)> InEventDispatcher)
{
    EventDispatcher = MoveTemp(InEventDispatcher);
}

FString UUnrealEditorWebUIBridge::ExecuteCommand(const FString& RequestJson)
{
    const FString RequestId = ExtractRequestId(RequestJson);

    if (RequestJson.IsEmpty())
    {
        return MakeErrorResponse(RequestId, TEXT("invalid_request"), TEXT("Request JSON cannot be empty."));
    }

    const FString PreflightJson = ExecuteRegistryFunction(RequestJson, TEXT("inspect_command"));
    const TSharedRef<FJsonObject> Preflight = ParseJsonObjectOrEmpty(PreflightJson);

    bool bPreflightOk = false;
    if (!Preflight->TryGetBoolField(TEXT("ok"), bPreflightOk) || !bPreflightOk)
    {
        return PreflightJson;
    }

    const TSharedPtr<FJsonValue> ResultValue = Preflight->TryGetField(TEXT("result"));
    const TSharedPtr<FJsonObject> ResultObject = ResultValue.IsValid() ? ResultValue->AsObject() : nullptr;
    if (!ResultObject.IsValid())
    {
        return MakeErrorResponse(RequestId, TEXT("invalid_preflight"), TEXT("Command preflight did not return a result object."));
    }

    FString CommandName;
    FString Permission;
    ResultObject->TryGetStringField(TEXT("command"), CommandName);
    ResultObject->TryGetStringField(TEXT("permission"), Permission);

    if (IsPrivilegedPermission(Permission)
        && (!CanReusePrivilegedApproval(Permission) || !HasPrivilegedCommandApproval(CommandName, Permission)))
    {
        if (!ConfirmPrivilegedCommand(CommandName, Permission))
        {
            return MakeErrorResponse(
                RequestId,
                TEXT("permission_denied"),
                FString::Printf(TEXT("User declined %s command: %s"), *Permission, *CommandName));
        }

        if (CanReusePrivilegedApproval(Permission))
        {
            GrantPrivilegedCommandApproval(CommandName, Permission);
        }
    }

    return ExecuteRegistryFunction(RequestJson, TEXT("execute_command"), MakePermissionPolicyJson(CommandName, Permission));
}

FString UUnrealEditorWebUIBridge::ExecuteRegistryFunction(
    const FString& RequestJson,
    const FString& FunctionName,
    const FString& PermissionPolicyJson) const
{
    const FString RequestId = ExtractRequestId(RequestJson);

    const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("UnrealEditorWebUI"));
    if (!Plugin.IsValid())
    {
        return MakeErrorResponse(RequestId, TEXT("plugin_not_found"), TEXT("UnrealEditorWebUI plugin directory was not found."));
    }

    IPythonScriptPlugin* PythonPlugin = IPythonScriptPlugin::Get();
    if (PythonPlugin == nullptr)
    {
        return MakeErrorResponse(RequestId, TEXT("python_unavailable"), TEXT("PythonScriptPlugin is unavailable."));
    }

    const FString PythonDir = FPaths::ConvertRelativePathToFull(
        FPaths::Combine(Plugin->GetBaseDir(), TEXT("Python")));

    const FString ResultDir = FPaths::ConvertRelativePathToFull(
        FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UnrealEditorWebUI")));
    IFileManager::Get().MakeDirectory(*ResultDir, true);

    const FString ResultPath = FPaths::CreateTempFilename(*ResultDir, TEXT("Command_"), TEXT(".json"));

    const FString EncodedPythonDir = EncodeBase64Utf8(PythonDir);
    const FString EncodedRequestJson = EncodeBase64Utf8(RequestJson);
    const FString EncodedResultPath = EncodeBase64Utf8(ResultPath);
    const FString EncodedFunctionName = EncodeBase64Utf8(FunctionName);
    const FString EncodedPermissionPolicyJson = EncodeBase64Utf8(PermissionPolicyJson);

    const FString PythonCode = FString::Printf(TEXT(
        "import base64, json, pathlib, sys, traceback\n"
        "request_id = None\n"
        "result_path = pathlib.Path(base64.b64decode('%s').decode('utf-8'))\n"
        "try:\n"
        "    plugin_python_dir = base64.b64decode('%s').decode('utf-8')\n"
        "    request_json = base64.b64decode('%s').decode('utf-8')\n"
        "    function_name = base64.b64decode('%s').decode('utf-8')\n"
        "    permission_policy_json = base64.b64decode('%s').decode('utf-8')\n"
        "    try:\n"
        "        parsed_request = json.loads(request_json)\n"
        "        request_id = parsed_request.get('id')\n"
        "    except Exception:\n"
        "        pass\n"
        "    if plugin_python_dir not in sys.path:\n"
        "        sys.path.insert(0, plugin_python_dir)\n"
        "    from unreal_editor_webui_registry import execute_command, inspect_command\n"
        "    if function_name == 'inspect_command':\n"
        "        response_json = inspect_command(request_json)\n"
        "    elif function_name == 'execute_command':\n"
        "        permission_policy = json.loads(permission_policy_json) if permission_policy_json else {}\n"
        "        response_json = execute_command(request_json, permission_policy)\n"
        "    else:\n"
        "        raise ValueError(f'Unsupported registry function: {function_name}')\n"
        "    result_path.write_text(response_json, encoding='utf-8')\n"
        "except Exception as exc:\n"
        "    traceback_text = traceback.format_exc()\n"
        "    try:\n"
        "        import unreal\n"
        "        unreal.log_error('Unreal Editor WebUI Python bridge failed.\\n' + traceback_text)\n"
        "    except Exception:\n"
        "        print(traceback_text)\n"
        "    response = {\n"
        "        'id': request_id,\n"
        "        'ok': False,\n"
        "        'error': {\n"
        "            'code': 'python_exception',\n"
        "            'message': str(exc),\n"
        "        },\n"
        "    }\n"
        "    result_path.write_text(json.dumps(response, ensure_ascii=False), encoding='utf-8')\n"),
        *EncodedResultPath,
        *EncodedPythonDir,
        *EncodedRequestJson,
        *EncodedFunctionName,
        *EncodedPermissionPolicyJson);

    const bool bExecuted = PythonPlugin->ExecPythonCommand(*PythonCode);
    if (!bExecuted)
    {
        IFileManager::Get().Delete(*ResultPath);
        return MakeErrorResponse(RequestId, TEXT("python_execution_failed"), TEXT("Failed to execute the Python command registry."));
    }

    FString ResponseJson;
    if (!FFileHelper::LoadFileToString(ResponseJson, *ResultPath))
    {
        return MakeErrorResponse(RequestId, TEXT("missing_response"), TEXT("Python command registry did not write a response."));
    }

    IFileManager::Get().Delete(*ResultPath);
    return ResponseJson;
}

FString UUnrealEditorWebUIBridge::StartCommand(const FString& RequestJson)
{
    if (RequestJson.IsEmpty())
    {
        return MakeErrorResponse(FString(), TEXT("invalid_request"), TEXT("Request JSON cannot be empty."));
    }

    const FString TaskId = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens);
    const FDateTime Now = FDateTime::UtcNow();

    {
        FScopeLock Lock(&TasksCriticalSection);
        PruneTasksLocked(Now);

        if (Tasks.Num() >= MaxStoredTasks)
        {
            return MakeErrorResponse(
                ExtractRequestId(RequestJson),
                TEXT("too_many_tasks"),
                FString::Printf(TEXT("Too many stored WebUI tasks. Remove completed tasks or wait for cleanup. Limit: %d."), MaxStoredTasks));
        }

        FUnrealEditorWebUITask& Task = Tasks.Add(TaskId);
        Task.RequestJson = RequestJson;
        Task.Status = TEXT("queued");
        Task.Progress = 0;
        Task.CreatedAt = Now;
        Task.UpdatedAt = Now;
        AppendTaskLogLocked(Task, TEXT("Task queued."));
    }
    BroadcastTaskEvent(TaskId, TEXT("queued"), FString(), 0, TEXT("Task queued."));

    const TWeakObjectPtr<UUnrealEditorWebUIBridge> WeakThis(this);
    AsyncTask(ENamedThreads::GameThread, [WeakThis, TaskId, RequestJson]()
    {
        if (WeakThis.IsValid())
        {
            WeakThis->RunTask(TaskId, RequestJson);
        }
    });

    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("taskId"), TaskId);
    Result->SetStringField(TEXT("status"), TEXT("queued"));
    Result->SetNumberField(TEXT("progress"), 0);
    return MakeSuccessResponse(ExtractRequestId(RequestJson), Result);
}

FString UUnrealEditorWebUIBridge::GetTask(const FString& TaskId) const
{
    FScopeLock Lock(&TasksCriticalSection);
    const FUnrealEditorWebUITask* Task = Tasks.Find(TaskId);
    if (Task == nullptr)
    {
        return MakeErrorResponse(FString(), TEXT("task_not_found"), FString::Printf(TEXT("Task not found: %s"), *TaskId));
    }

    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("taskId"), TaskId);
    Result->SetStringField(TEXT("status"), Task->Status);
    Result->SetNumberField(TEXT("progress"), Task->Progress);
    Result->SetStringField(TEXT("createdAt"), Task->CreatedAt.ToIso8601());
    Result->SetStringField(TEXT("updatedAt"), Task->UpdatedAt.ToIso8601());

    TArray<TSharedPtr<FJsonValue>> LogValues;
    for (const FString& LogLine : Task->Logs)
    {
        LogValues.Add(MakeShared<FJsonValueString>(LogLine));
    }
    Result->SetArrayField(TEXT("logs"), LogValues);

    if (!Task->ResponseJson.IsEmpty())
    {
        Result->SetStringField(TEXT("responseJson"), Task->ResponseJson);
    }

    return MakeSuccessResponse(FString(), Result);
}

FString UUnrealEditorWebUIBridge::RemoveTask(const FString& TaskId)
{
    FScopeLock Lock(&TasksCriticalSection);
    if (Tasks.Remove(TaskId) == 0)
    {
        return MakeErrorResponse(FString(), TEXT("task_not_found"), FString::Printf(TEXT("Task not found: %s"), *TaskId));
    }

    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("taskId"), TaskId);
    Result->SetBoolField(TEXT("removed"), true);
    return MakeSuccessResponse(FString(), Result);
}

FString UUnrealEditorWebUIBridge::CancelTask(const FString& TaskId)
{
    FString Status;
    {
        FScopeLock Lock(&TasksCriticalSection);
        FUnrealEditorWebUITask* Task = Tasks.Find(TaskId);
        if (Task == nullptr)
        {
            return MakeErrorResponse(FString(), TEXT("task_not_found"), FString::Printf(TEXT("Task not found: %s"), *TaskId));
        }

        if (Task->Status == TEXT("queued"))
        {
            Task->Status = TEXT("cancelled");
            Task->Progress = 100;
            Task->UpdatedAt = FDateTime::UtcNow();
            AppendTaskLogLocked(*Task, TEXT("Task cancelled before execution."));
            Status = Task->Status;
        }
        else if (Task->Status == TEXT("running"))
        {
            return MakeErrorResponse(
                FString(),
                TEXT("task_already_running"),
                TEXT("Running Python commands cannot be interrupted by the current task runner."));
        }
        else
        {
            return MakeErrorResponse(
                FString(),
                TEXT("task_not_cancellable"),
                FString::Printf(TEXT("Task is already %s."), *Task->Status));
        }
    }

    BroadcastTaskEvent(TaskId, Status, FString(), 100, TEXT("Task cancelled before execution."));

    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("taskId"), TaskId);
    Result->SetStringField(TEXT("status"), Status);
    Result->SetNumberField(TEXT("progress"), 100);
    Result->SetBoolField(TEXT("cancelled"), true);
    return MakeSuccessResponse(FString(), Result);
}

FString UUnrealEditorWebUIBridge::GetWebUISettings() const
{
    return MakeSuccessResponse(FString(), ParseJsonObjectOrEmpty(UnrealEditorWebUISettings::ToJson(UnrealEditorWebUISettings::Load())));
}

FString UUnrealEditorWebUIBridge::SetWebUISettings(const FString& SettingsJson)
{
    FUnrealEditorWebUISettings Settings;
    FString Error;
    if (!UnrealEditorWebUISettings::FromJson(SettingsJson, Settings, Error))
    {
        return MakeErrorResponse(FString(), TEXT("invalid_settings"), Error);
    }

    UnrealEditorWebUISettings::Save(Settings);
    return MakeSuccessResponse(FString(), ParseJsonObjectOrEmpty(UnrealEditorWebUISettings::ToJson(Settings)));
}

bool UUnrealEditorWebUIBridge::ConfirmPrivilegedCommand(const FString& CommandName, const FString& Permission) const
{
    const FText Title = NSLOCTEXT("UnrealEditorWebUIBridge", "ConfirmPrivilegedCommandTitle", "Confirm WebUI Command");
    const FText ApprovalScope = CanReusePrivilegedApproval(Permission)
        ? NSLOCTEXT(
            "UnrealEditorWebUIBridge",
            "ConfirmPrivilegedCommandSessionScope",
            "Confirming will allow this specific command for the current WebUI tab session.")
        : NSLOCTEXT(
            "UnrealEditorWebUIBridge",
            "ConfirmPrivilegedCommandSingleUseScope",
            "Destructive commands require confirmation every time.");
    const FText Message = FText::Format(
        NSLOCTEXT(
            "UnrealEditorWebUIBridge",
            "ConfirmPrivilegedCommandMessage",
            "Run {0} command \"{1}\" from the WebUI?\n\n{2}\n\nOnly continue if you trust the currently loaded page."),
        FText::FromString(Permission),
        FText::FromString(CommandName),
        ApprovalScope);

    return FMessageDialog::Open(EAppMsgType::YesNo, Message, &Title) == EAppReturnType::Yes;
}

bool UUnrealEditorWebUIBridge::HasPrivilegedCommandApproval(const FString& CommandName, const FString& Permission) const
{
    FScopeLock Lock(&PrivilegedCommandApprovalsCriticalSection);
    return PrivilegedCommandApprovals.Contains(MakePrivilegedCommandKey(CommandName, Permission));
}

void UUnrealEditorWebUIBridge::GrantPrivilegedCommandApproval(const FString& CommandName, const FString& Permission)
{
    FScopeLock Lock(&PrivilegedCommandApprovalsCriticalSection);
    PrivilegedCommandApprovals.Add(MakePrivilegedCommandKey(CommandName, Permission));
}

void UUnrealEditorWebUIBridge::PruneTasksLocked(const FDateTime& Now)
{
    const FTimespan FinishedTaskRetention = FTimespan::FromMinutes(10);

    for (auto It = Tasks.CreateIterator(); It; ++It)
    {
        const FUnrealEditorWebUITask& Task = It.Value();
        if (IsFinishedTaskStatus(Task.Status) && Now - Task.UpdatedAt > FinishedTaskRetention)
        {
            It.RemoveCurrent();
        }
    }

    while (Tasks.Num() > MaxStoredTasks)
    {
        FString OldestFinishedTaskId;
        FDateTime OldestFinishedTaskTime = FDateTime::MaxValue();

        for (const TPair<FString, FUnrealEditorWebUITask>& Pair : Tasks)
        {
            if (IsFinishedTaskStatus(Pair.Value.Status) && Pair.Value.UpdatedAt < OldestFinishedTaskTime)
            {
                OldestFinishedTaskId = Pair.Key;
                OldestFinishedTaskTime = Pair.Value.UpdatedAt;
            }
        }

        if (OldestFinishedTaskId.IsEmpty())
        {
            break;
        }

        Tasks.Remove(OldestFinishedTaskId);
    }
}

void UUnrealEditorWebUIBridge::RunTask(const FString TaskId, const FString RequestJson)
{
    {
        FScopeLock Lock(&TasksCriticalSection);
        const FUnrealEditorWebUITask* Task = Tasks.Find(TaskId);
        if (Task == nullptr || Task->Status == TEXT("cancelled"))
        {
            return;
        }
    }

    UpdateTaskStatus(TaskId, TEXT("running"), FString(), 10, TEXT("Task running on the editor game thread."));

    const FString ResponseJson = ExecuteCommand(RequestJson);
    const TSharedRef<FJsonObject> Response = ParseJsonObjectOrEmpty(ResponseJson);

    bool bOk = false;
    Response->TryGetBoolField(TEXT("ok"), bOk);

    UpdateTaskStatus(
        TaskId,
        bOk ? TEXT("completed") : TEXT("failed"),
        ResponseJson,
        100,
        bOk ? TEXT("Task completed.") : TEXT("Task failed."));
}

void UUnrealEditorWebUIBridge::UpdateTaskStatus(
    const FString& TaskId,
    const FString& Status,
    const FString& ResponseJson,
    int32 Progress,
    const FString& LogLine)
{
    {
        FScopeLock Lock(&TasksCriticalSection);
        if (FUnrealEditorWebUITask* Task = Tasks.Find(TaskId))
        {
            Task->Status = Status;
            Task->UpdatedAt = FDateTime::UtcNow();
            if (Progress != INDEX_NONE)
            {
                Task->Progress = FMath::Clamp(Progress, 0, 100);
            }
            if (!ResponseJson.IsEmpty())
            {
                Task->ResponseJson = ResponseJson;
            }
            AppendTaskLogLocked(*Task, LogLine);
        }
    }

    BroadcastTaskEvent(TaskId, Status, ResponseJson, Progress, LogLine);
}

void UUnrealEditorWebUIBridge::BroadcastTaskEvent(
    const FString& TaskId,
    const FString& Status,
    const FString& ResponseJson,
    int32 Progress,
    const FString& LogLine)
{
    if (!EventDispatcher)
    {
        return;
    }

    const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
    Root->SetStringField(TEXT("type"), TEXT("task.status"));
    Root->SetStringField(TEXT("taskId"), TaskId);
    Root->SetStringField(TEXT("status"), Status);
    Root->SetStringField(TEXT("updatedAt"), FDateTime::UtcNow().ToIso8601());
    if (Progress != INDEX_NONE)
    {
        Root->SetNumberField(TEXT("progress"), FMath::Clamp(Progress, 0, 100));
    }
    if (!LogLine.IsEmpty())
    {
        Root->SetStringField(TEXT("log"), LogLine);
    }
    if (!ResponseJson.IsEmpty())
    {
        Root->SetStringField(TEXT("responseJson"), ResponseJson);
    }

    EventDispatcher(WriteJsonObject(Root));
}
