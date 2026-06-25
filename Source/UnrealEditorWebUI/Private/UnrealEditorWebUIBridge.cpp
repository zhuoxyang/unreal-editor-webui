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
#include "Misc/ScopeExit.h"
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
        return Status == TEXT("completed") || Status == TEXT("failed") || Status == TEXT("cancelled") || Status == TEXT("timed_out");
    }

    bool IsCooperativeExecutionThread(const FString& ExecutionThread)
    {
        return ExecutionThread.ToLower() == TEXT("editor_tick");
    }

    double ParseTimeoutSeconds(const FString& TimeoutPolicy)
    {
        const FString Normalized = TimeoutPolicy.ToLower();
        if (!Normalized.StartsWith(TEXT("seconds:")))
        {
            return 0.0;
        }

        return FCString::Atod(*Normalized.Mid(8));
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

    void ApplyTaskLifecycleForStatusLocked(FUnrealEditorWebUITask& Task)
    {
        if (Task.ExecutionThread.IsEmpty())
        {
            Task.ExecutionThread = TEXT("editor_game_thread");
        }
        if (Task.CancellationMode.IsEmpty())
        {
            Task.CancellationMode = TEXT("queued_only");
        }
        if (Task.TimeoutPolicy.IsEmpty())
        {
            Task.TimeoutPolicy = TEXT("none");
        }

        if (Task.Status == TEXT("queued"))
        {
            Task.bCancellable = true;
            Task.StatusMessage = TEXT("Queued for editor-thread Python execution.");
        }
        else if (Task.Status == TEXT("running"))
        {
            Task.bCancellable = Task.CancellationMode.ToLower() == TEXT("cooperative");
            Task.StatusMessage = Task.bCancellable
                ? TEXT("Running cooperatively on the editor tick and can be cancelled.")
                : TEXT("Running editor-thread Python commands cannot be interrupted safely.");
        }
        else if (Task.Status == TEXT("completed"))
        {
            Task.bCancellable = false;
            Task.StatusMessage = TEXT("Task completed.");
        }
        else if (Task.Status == TEXT("failed"))
        {
            Task.bCancellable = false;
            Task.StatusMessage = TEXT("Task failed.");
        }
        else if (Task.Status == TEXT("cancelled"))
        {
            Task.bCancellable = false;
            Task.StatusMessage = TEXT("Task cancelled before execution.");
        }
        else if (Task.Status == TEXT("timed_out"))
        {
            Task.bCancellable = false;
            Task.StatusMessage = TEXT("Task timed out before execution.");
        }
    }

    void WriteTaskResultFields(const TSharedRef<FJsonObject>& Result, const FString& TaskId, const FUnrealEditorWebUITask& Task)
    {
        Result->SetStringField(TEXT("taskId"), TaskId);
        Result->SetStringField(TEXT("status"), Task.Status);
        Result->SetNumberField(TEXT("progress"), Task.Progress);
        Result->SetBoolField(TEXT("cancellable"), Task.bCancellable);
        Result->SetStringField(TEXT("cancellationMode"), Task.CancellationMode);
        Result->SetStringField(TEXT("executionThread"), Task.ExecutionThread);
        Result->SetStringField(TEXT("timeoutPolicy"), Task.TimeoutPolicy);
        Result->SetStringField(TEXT("message"), Task.StatusMessage);
        Result->SetStringField(TEXT("createdAt"), Task.CreatedAt.ToIso8601());
        Result->SetStringField(TEXT("updatedAt"), Task.UpdatedAt.ToIso8601());

        const TSharedRef<FJsonObject> Request = ParseJsonObjectOrEmpty(Task.RequestJson);
        FString CommandName;
        if (Request->TryGetStringField(TEXT("command"), CommandName))
        {
            Result->SetStringField(TEXT("command"), CommandName);
        }
        const TSharedPtr<FJsonValue> PayloadValue = Request->TryGetField(TEXT("payload"));
        if (PayloadValue.IsValid() && PayloadValue->Type == EJson::Object)
        {
            Result->SetField(TEXT("payload"), PayloadValue);
        }

        TArray<TSharedPtr<FJsonValue>> LogValues;
        for (const FString& LogLine : Task.Logs)
        {
            LogValues.Add(MakeShared<FJsonValueString>(LogLine));
        }
        Result->SetArrayField(TEXT("logs"), LogValues);

        if (!Task.ResponseJson.IsEmpty())
        {
            Result->SetStringField(TEXT("responseJson"), Task.ResponseJson);
        }
    }

    bool IsPrivilegedPermission(const FString& Permission)
    {
        const FString Normalized = Permission.ToLower();
        return Normalized == TEXT("write") || Normalized == TEXT("destructive");
    }

    bool IsSupportedPermission(const FString& Permission)
    {
        const FString Normalized = Permission.ToLower();
        return Normalized == TEXT("read") || IsPrivilegedPermission(Normalized);
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

void UUnrealEditorWebUIBridge::ResetPrivilegedCommandApprovals()
{
    FScopeLock Lock(&PrivilegedCommandApprovalsCriticalSection);
    PrivilegedCommandApprovals.Reset();
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

    if (CommandName.IsEmpty() || !IsSupportedPermission(Permission))
    {
        return MakeErrorResponse(
            RequestId,
            TEXT("invalid_preflight"),
            TEXT("Command preflight returned invalid command permission metadata."));
    }

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
    ON_SCOPE_EXIT
    {
        IFileManager::Get().Delete(*ResultPath);
    };

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
        return MakeErrorResponse(RequestId, TEXT("python_execution_failed"), TEXT("Failed to execute the Python command registry."));
    }

    FString ResponseJson;
    if (!FFileHelper::LoadFileToString(ResponseJson, *ResultPath))
    {
        return MakeErrorResponse(RequestId, TEXT("missing_response"), TEXT("Python command registry did not write a response."));
    }

    return ResponseJson;
}

FString UUnrealEditorWebUIBridge::StartCommand(const FString& RequestJson)
{
    if (RequestJson.IsEmpty())
    {
        return MakeErrorResponse(FString(), TEXT("invalid_request"), TEXT("Request JSON cannot be empty."));
    }

    const FString PreflightJson = ExecuteRegistryFunction(RequestJson, TEXT("inspect_command"));
    const TSharedRef<FJsonObject> Preflight = ParseJsonObjectOrEmpty(PreflightJson);

    bool bPreflightOk = false;
    if (!Preflight->TryGetBoolField(TEXT("ok"), bPreflightOk) || !bPreflightOk)
    {
        return PreflightJson;
    }

    FString ExecutionThread;
    FString CancellationMode;
    FString TimeoutPolicy;
    const TSharedPtr<FJsonObject> PreflightResult = Preflight->GetObjectField(TEXT("result"));
    if (PreflightResult.IsValid())
    {
        const TSharedPtr<FJsonObject>* ExecutionObject = nullptr;
        if (PreflightResult->TryGetObjectField(TEXT("execution"), ExecutionObject) && ExecutionObject != nullptr && ExecutionObject->IsValid())
        {
            (*ExecutionObject)->TryGetStringField(TEXT("thread"), ExecutionThread);
            (*ExecutionObject)->TryGetStringField(TEXT("cancellationMode"), CancellationMode);
            (*ExecutionObject)->TryGetStringField(TEXT("timeoutPolicy"), TimeoutPolicy);
        }
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
        Task.ExecutionThread = ExecutionThread;
        Task.CancellationMode = CancellationMode;
        Task.TimeoutPolicy = TimeoutPolicy;
        Task.Progress = 0;
        Task.CreatedAt = Now;
        Task.UpdatedAt = Now;
        ApplyTaskLifecycleForStatusLocked(Task);
        AppendTaskLogLocked(Task, TEXT("Task queued."));
    }
    BroadcastTaskEvent(TaskId, TEXT("queued"), FString(), 0, TEXT("Task queued."));

    if (IsCooperativeExecutionThread(ExecutionThread))
    {
        StartCooperativeTask(TaskId, RequestJson);
    }
    else
    {
        const TWeakObjectPtr<UUnrealEditorWebUIBridge> WeakThis(this);
        AsyncTask(ENamedThreads::GameThread, [WeakThis, TaskId, RequestJson]()
        {
            if (WeakThis.IsValid())
            {
                WeakThis->RunTask(TaskId, RequestJson);
            }
        });
    }

    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    {
        FScopeLock Lock(&TasksCriticalSection);
        if (const FUnrealEditorWebUITask* Task = Tasks.Find(TaskId))
        {
            WriteTaskResultFields(Result, TaskId, *Task);
        }
    }
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
    WriteTaskResultFields(Result, TaskId, *Task);

    return MakeSuccessResponse(FString(), Result);
}

FString UUnrealEditorWebUIBridge::ListTasks() const
{
    FScopeLock Lock(&TasksCriticalSection);

    TArray<FString> TaskIds;
    Tasks.GetKeys(TaskIds);
    TaskIds.Sort([this](const FString& Left, const FString& Right)
    {
        return Tasks.FindChecked(Left).CreatedAt > Tasks.FindChecked(Right).CreatedAt;
    });

    TArray<TSharedPtr<FJsonValue>> TaskValues;
    TaskValues.Reserve(TaskIds.Num());
    for (const FString& TaskId : TaskIds)
    {
        const TSharedRef<FJsonObject> TaskObject = MakeShared<FJsonObject>();
        WriteTaskResultFields(TaskObject, TaskId, Tasks.FindChecked(TaskId));
        TaskValues.Add(MakeShared<FJsonValueObject>(TaskObject));
    }

    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetArrayField(TEXT("tasks"), TaskValues);
    return MakeSuccessResponse(FString(), Result);
}

FString UUnrealEditorWebUIBridge::RemoveTask(const FString& TaskId)
{
    FScopeLock Lock(&TasksCriticalSection);
    const FUnrealEditorWebUITask* Task = Tasks.Find(TaskId);
    if (Task == nullptr)
    {
        return MakeErrorResponse(FString(), TEXT("task_not_found"), FString::Printf(TEXT("Task not found: %s"), *TaskId));
    }
    if (!IsFinishedTaskStatus(Task->Status))
    {
        return MakeErrorResponse(
            FString(),
            TEXT("task_not_finished"),
            FString::Printf(TEXT("Task must finish before removal. Current status: %s"), *Task->Status));
    }

    Tasks.Remove(TaskId);

    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("taskId"), TaskId);
    Result->SetBoolField(TEXT("removed"), true);
    return MakeSuccessResponse(FString(), Result);
}

FString UUnrealEditorWebUIBridge::CancelTask(const FString& TaskId)
{
    FString Status;
    bool bCancelled = false;
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
            ApplyTaskLifecycleForStatusLocked(*Task);
            AppendTaskLogLocked(*Task, TEXT("Task cancelled before execution."));
            Status = Task->Status;
            bCancelled = true;
        }
        else if (Task->Status == TEXT("running"))
        {
            if (Task->CancellationMode.ToLower() == TEXT("cooperative"))
            {
                Task->bCancellationRequested = true;
                Task->UpdatedAt = FDateTime::UtcNow();
                ApplyTaskLifecycleForStatusLocked(*Task);
                AppendTaskLogLocked(*Task, TEXT("Cooperative cancellation requested."));
            }
            else
            {
                ApplyTaskLifecycleForStatusLocked(*Task);
                Task->UpdatedAt = FDateTime::UtcNow();
                AppendTaskLogLocked(*Task, TEXT("Cancellation requested, but this running editor-thread task is non-cancellable."));
            }
            Status = Task->Status;
        }
        else
        {
            return MakeErrorResponse(
                FString(),
                TEXT("task_not_cancellable"),
                FString::Printf(TEXT("Task is already %s."), *Task->Status));
        }
    }

    BroadcastTaskEvent(
        TaskId,
        Status,
        FString(),
        bCancelled ? 100 : INDEX_NONE,
        bCancelled
            ? TEXT("Task cancelled before execution.")
            : TEXT("Cancellation requested."));

    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    {
        FScopeLock Lock(&TasksCriticalSection);
        if (const FUnrealEditorWebUITask* Task = Tasks.Find(TaskId))
        {
            WriteTaskResultFields(Result, TaskId, *Task);
        }
    }
    Result->SetBoolField(TEXT("cancelled"), bCancelled);
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

    if (!ConfirmPrivilegedCommand(TEXT("settings.update"), TEXT("write"), false))
    {
        return MakeErrorResponse(
            FString(),
            TEXT("permission_denied"),
            TEXT("User declined the WebUI settings update."));
    }

    UnrealEditorWebUISettings::Save(Settings);
    return MakeSuccessResponse(FString(), ParseJsonObjectOrEmpty(UnrealEditorWebUISettings::ToJson(Settings)));
}

bool UUnrealEditorWebUIBridge::ConfirmPrivilegedCommand(
    const FString& CommandName,
    const FString& Permission,
    bool bAllowReusableApproval) const
{
    const FText Title = NSLOCTEXT("UnrealEditorWebUIBridge", "ConfirmPrivilegedCommandTitle", "Confirm WebUI Command");
    const FText ApprovalScope = bAllowReusableApproval && CanReusePrivilegedApproval(Permission)
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

    return FMessageDialog::Open(EAppMsgType::YesNo, Message, Title) == EAppReturnType::Yes;
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

void UUnrealEditorWebUIBridge::StartCooperativeTask(const FString& TaskId, const FString& RequestJson)
{
    int32 TotalSteps = 10;
    const TSharedRef<FJsonObject> Request = ParseJsonObjectOrEmpty(RequestJson);
    const TSharedPtr<FJsonValue> PayloadValue = Request->TryGetField(TEXT("payload"));
    const TSharedPtr<FJsonObject> Payload = PayloadValue.IsValid() ? PayloadValue->AsObject() : nullptr;
    if (Payload.IsValid())
    {
        double RequestedSteps = 0.0;
        if (Payload->TryGetNumberField(TEXT("steps"), RequestedSteps))
        {
            TotalSteps = FMath::Clamp(FMath::RoundToInt(RequestedSteps), 1, 100);
        }
    }

    {
        FScopeLock Lock(&TasksCriticalSection);
        if (FUnrealEditorWebUITask* Task = Tasks.Find(TaskId))
        {
            Task->Status = TEXT("running");
            Task->Progress = 1;
            Task->CooperativeStep = 0;
            Task->CooperativeTotalSteps = TotalSteps;
            Task->UpdatedAt = FDateTime::UtcNow();
            ApplyTaskLifecycleForStatusLocked(*Task);
            AppendTaskLogLocked(*Task, FString::Printf(TEXT("Cooperative task started with %d step(s)."), TotalSteps));
        }
    }

    BroadcastTaskEvent(TaskId, TEXT("running"), FString(), 1, TEXT("Cooperative task started."));
    EnsureCooperativeTicker();
}

bool UUnrealEditorWebUIBridge::TickCooperativeTasks(float DeltaTime)
{
    TArray<FString> TaskIds;
    {
        FScopeLock Lock(&TasksCriticalSection);
        for (const TPair<FString, FUnrealEditorWebUITask>& Pair : Tasks)
        {
            if (Pair.Value.Status == TEXT("running") && IsCooperativeExecutionThread(Pair.Value.ExecutionThread))
            {
                TaskIds.Add(Pair.Key);
            }
        }
    }

    for (const FString& TaskId : TaskIds)
    {
        FString TerminalStatus;
        FString TerminalResponseJson;
        FString LogLine;
        int32 Progress = INDEX_NONE;

        {
            FScopeLock Lock(&TasksCriticalSection);
            FUnrealEditorWebUITask* Task = Tasks.Find(TaskId);
            if (Task == nullptr || Task->Status != TEXT("running"))
            {
                continue;
            }

            if (Task->bCancellationRequested)
            {
                TerminalStatus = TEXT("cancelled");
                Progress = 100;
                LogLine = TEXT("Cooperative task cancelled.");
            }
            else
            {
                const double TimeoutSeconds = ParseTimeoutSeconds(Task->TimeoutPolicy);
                if (TimeoutSeconds > 0.0 && (FDateTime::UtcNow() - Task->CreatedAt).GetTotalSeconds() >= TimeoutSeconds)
                {
                    TerminalStatus = TEXT("timed_out");
                    Progress = 100;
                    LogLine = FString::Printf(TEXT("Task timed out after %.2f second(s)."), TimeoutSeconds);
                }
                else
                {
                    Task->CooperativeStep = FMath::Min(Task->CooperativeStep + 1, FMath::Max(1, Task->CooperativeTotalSteps));
                    const int32 TotalSteps = FMath::Max(1, Task->CooperativeTotalSteps);
                    Progress = FMath::Clamp(FMath::RoundToInt((static_cast<float>(Task->CooperativeStep) / static_cast<float>(TotalSteps)) * 100.0f), 1, 100);
                    LogLine = FString::Printf(TEXT("Cooperative step %d/%d."), Task->CooperativeStep, TotalSteps);

                    if (Task->CooperativeStep >= TotalSteps)
                    {
                        TerminalStatus = TEXT("completed");

                        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
                        Result->SetStringField(TEXT("mode"), TEXT("cooperative"));
                        Result->SetNumberField(TEXT("steps"), TotalSteps);
                        Result->SetStringField(TEXT("message"), TEXT("Cooperative demo task completed without blocking the editor."));
                        TerminalResponseJson = MakeSuccessResponse(ExtractRequestId(Task->RequestJson), Result);
                    }
                }
            }
        }

        if (!TerminalStatus.IsEmpty())
        {
            UpdateTaskStatus(TaskId, TerminalStatus, TerminalResponseJson, 100, LogLine);
        }
        else
        {
            UpdateTaskStatus(TaskId, TEXT("running"), FString(), Progress, LogLine);
        }
    }

    StopCooperativeTickerIfIdle();
    return CooperativeTaskTickerHandle.IsValid();
}

void UUnrealEditorWebUIBridge::EnsureCooperativeTicker()
{
    if (CooperativeTaskTickerHandle.IsValid())
    {
        return;
    }

    CooperativeTaskTickerHandle = FTSTicker::GetCoreTicker().AddTicker(
        FTickerDelegate::CreateUObject(this, &UUnrealEditorWebUIBridge::TickCooperativeTasks),
        0.25f);
}

void UUnrealEditorWebUIBridge::StopCooperativeTickerIfIdle()
{
    bool bHasCooperativeTask = false;
    {
        FScopeLock Lock(&TasksCriticalSection);
        for (const TPair<FString, FUnrealEditorWebUITask>& Pair : Tasks)
        {
            if (Pair.Value.Status == TEXT("running") && IsCooperativeExecutionThread(Pair.Value.ExecutionThread))
            {
                bHasCooperativeTask = true;
                break;
            }
        }
    }

    if (!bHasCooperativeTask && CooperativeTaskTickerHandle.IsValid())
    {
        FTSTicker::GetCoreTicker().RemoveTicker(CooperativeTaskTickerHandle);
        CooperativeTaskTickerHandle.Reset();
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
            ApplyTaskLifecycleForStatusLocked(*Task);
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
    {
        FScopeLock Lock(&TasksCriticalSection);
        if (const FUnrealEditorWebUITask* Task = Tasks.Find(TaskId))
        {
            Root->SetBoolField(TEXT("cancellable"), Task->bCancellable);
            Root->SetStringField(TEXT("cancellationMode"), Task->CancellationMode);
            Root->SetStringField(TEXT("executionThread"), Task->ExecutionThread);
            Root->SetStringField(TEXT("timeoutPolicy"), Task->TimeoutPolicy);
            Root->SetStringField(TEXT("message"), Task->StatusMessage);
        }
    }
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
