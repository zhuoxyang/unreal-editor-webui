#include "UnrealEditorWebUIBridge.h"
#include "UnrealEditorWebUISettings.h"

#include "Async/Async.h"
#include "Dom/JsonObject.h"
#include "IPythonScriptPlugin.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/App.h"
#include "Misc/Base64.h"
#include "Misc/Guid.h"
#include "Misc/LexFromString.h"
#include "Misc/MessageDialog.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "Misc/SecureHash.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "PythonScriptTypes.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

DEFINE_LOG_CATEGORY_STATIC(LogUnrealEditorWebUIBridge, Log, All);

namespace
{
    constexpr int32 MaxStoredTasks = 64;
    constexpr int32 MaxTaskLogLines = 80;
    constexpr int32 MaxTaskLogLineCharacters = 2048;
    constexpr int32 MaxRequestJsonCharacters = 256 * 1024;
    constexpr int32 MaxResponseJsonUtf8Bytes = 4 * 1024 * 1024;
    constexpr int32 MaxTaskResponseJsonUtf8Bytes = 1536 * 1024;
    constexpr int32 MaxTaskEventJsonUtf8Bytes = 64 * 1024;
    constexpr int32 MaxPermissionPolicyCharacters = 16 * 1024;
    constexpr int32 MaxSettingsJsonCharacters = 64 * 1024;
    constexpr int32 MaxPostMessageCharacters = 16 * 1024;
    constexpr int32 MaxTaskIdCharacters = 128;
    constexpr int64 MaxRetainedTaskResponseCharacters = 16LL * 1024LL * 1024LL;

    FString WriteJsonObject(const TSharedRef<FJsonObject>& JsonObject)
    {
        FString Output;
        const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
            TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output);
        FJsonSerializer::Serialize(JsonObject, Writer);
        return Output;
    }

    int32 Utf8ByteLength(const FString& Value)
    {
        return FTCHARToUTF8(*Value).Length();
    }

    FString BuildProjectStorageNamespace(const FString& ProjectIdentity)
    {
        const FTCHARToUTF8 Utf8Identity(*ProjectIdentity);
        const FString ProjectHash = FMD5::HashBytes(
            reinterpret_cast<const uint8*>(Utf8Identity.Get()),
            static_cast<uint64>(Utf8Identity.Length()));
        return FString::Printf(TEXT("project-%s"), *ProjectHash.Left(24));
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

    FString MakeBoundedSuccessResponse(
        const FString& RequestId,
        const TSharedRef<FJsonObject>& Result)
    {
        const FString Response = MakeSuccessResponse(RequestId, Result);
        if (Utf8ByteLength(Response) <= MaxResponseJsonUtf8Bytes)
        {
            return Response;
        }

        return MakeErrorResponse(
            RequestId,
            TEXT("response_too_large"),
            TEXT("Serialized bridge response exceeds the maximum size of 4 MiB UTF-8."));
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

        const FString BoundedLogLine = LogLine.Len() > MaxTaskLogLineCharacters
            ? LogLine.Left(MaxTaskLogLineCharacters) + TEXT("...")
            : LogLine;
        Task.Logs.Add(BoundedLogLine);
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

    void WriteTaskSummaryFields(
        const TSharedRef<FJsonObject>& Result,
        const FString& TaskId,
        const FUnrealEditorWebUITask& Task)
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

        if (!Task.CommandName.IsEmpty())
        {
            Result->SetStringField(TEXT("command"), Task.CommandName);
        }
    }

    void WriteTaskResultFields(
        const TSharedRef<FJsonObject>& Result,
        const FString& TaskId,
        const FUnrealEditorWebUITask& Task)
    {
        WriteTaskSummaryFields(Result, TaskId, Task);

        const TSharedRef<FJsonObject> Request = ParseJsonObjectOrEmpty(Task.RequestJson);
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

    FString MakePermissionPolicyJson(
        const FString& CommandName,
        const FString& Permission,
        const FString& TaskId = FString())
    {
        const TSharedRef<FJsonObject> Policy = MakeShared<FJsonObject>();
        Policy->SetStringField(TEXT("allowedCommand"), CommandName);
        Policy->SetStringField(TEXT("allowedPermission"), Permission.ToLower());
        if (!TaskId.IsEmpty())
        {
            Policy->SetStringField(TEXT("taskId"), TaskId);
        }
        return WriteJsonObject(Policy);
    }

    FString MakeCooperativeControlJson(
        const FString& RequestId,
        const FString& TaskId,
        bool bCancelRequested)
    {
        const TSharedRef<FJsonObject> Control = MakeShared<FJsonObject>();
        SetNullableId(Control, RequestId);
        Control->SetStringField(TEXT("taskId"), TaskId);
        Control->SetBoolField(TEXT("cancelRequested"), bCancelRequested);
        return WriteJsonObject(Control);
    }

    struct FCommandPreflight
    {
        bool bSuccess = false;
        FString ResponseJson;
        FString CommandName;
        FString Permission;
        FString ExecutionThread;
        FString CancellationMode;
        FString TimeoutPolicy;
        FString PayloadSummary;
    };

    bool IsSupportedTimeoutPolicy(const FString& TimeoutPolicy)
    {
        const FString Normalized = TimeoutPolicy.ToLower();
        if (Normalized == TEXT("none"))
        {
            return true;
        }
        if (!Normalized.StartsWith(TEXT("seconds:")))
        {
            return false;
        }

        const FString SecondsText = Normalized.Mid(8);
        double Seconds = 0.0;
        return !SecondsText.IsEmpty()
            && LexTryParseString(Seconds, *SecondsText)
            && FMath::IsFinite(Seconds)
            && Seconds > 0.0;
    }

    bool IsSupportedExecutionMetadata(
        const FString& ExecutionThread,
        const FString& CancellationMode,
        const FString& TimeoutPolicy)
    {
        const FString NormalizedThread = ExecutionThread.ToLower();
        const FString NormalizedCancellation = CancellationMode.ToLower();
        const FString NormalizedTimeout = TimeoutPolicy.ToLower();

        if (!IsSupportedTimeoutPolicy(NormalizedTimeout))
        {
            return false;
        }
        if (NormalizedThread == TEXT("editor_game_thread"))
        {
            return NormalizedCancellation == TEXT("queued_only")
                && NormalizedTimeout == TEXT("none");
        }
        if (NormalizedThread == TEXT("editor_tick"))
        {
            return NormalizedCancellation == TEXT("cooperative");
        }
        return false;
    }

    FCommandPreflight ParseCommandPreflight(
        const FString& RequestId,
        const FString& PreflightJson)
    {
        FCommandPreflight Parsed;

        TSharedPtr<FJsonObject> Preflight;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(PreflightJson);
        if (!FJsonSerializer::Deserialize(Reader, Preflight) || !Preflight.IsValid())
        {
            Parsed.ResponseJson = MakeErrorResponse(
                RequestId,
                TEXT("invalid_preflight"),
                TEXT("Command preflight did not return a JSON object."));
            return Parsed;
        }

        bool bPreflightOk = false;
        if (!Preflight->TryGetBoolField(TEXT("ok"), bPreflightOk))
        {
            Parsed.ResponseJson = MakeErrorResponse(
                RequestId,
                TEXT("invalid_preflight"),
                TEXT("Command preflight response is missing a boolean ok field."));
            return Parsed;
        }

        if (!bPreflightOk)
        {
            const TSharedPtr<FJsonObject>* ErrorObject = nullptr;
            FString ErrorCode;
            FString ErrorMessage;
            if (Preflight->TryGetObjectField(TEXT("error"), ErrorObject)
                && ErrorObject != nullptr
                && ErrorObject->IsValid()
                && (*ErrorObject)->TryGetStringField(TEXT("code"), ErrorCode)
                && !ErrorCode.IsEmpty()
                && (*ErrorObject)->TryGetStringField(TEXT("message"), ErrorMessage)
                && !ErrorMessage.IsEmpty())
            {
                Parsed.ResponseJson = PreflightJson;
                return Parsed;
            }

            Parsed.ResponseJson = MakeErrorResponse(
                RequestId,
                TEXT("invalid_preflight"),
                TEXT("Command preflight returned an invalid error envelope."));
            return Parsed;
        }

        const TSharedPtr<FJsonObject>* ResultObject = nullptr;
        if (!Preflight->TryGetObjectField(TEXT("result"), ResultObject)
            || ResultObject == nullptr
            || !ResultObject->IsValid())
        {
            Parsed.ResponseJson = MakeErrorResponse(
                RequestId,
                TEXT("invalid_preflight"),
                TEXT("Command preflight did not return a result object."));
            return Parsed;
        }

        if (!(*ResultObject)->TryGetStringField(TEXT("command"), Parsed.CommandName)
            || Parsed.CommandName.IsEmpty()
            || !(*ResultObject)->TryGetStringField(TEXT("permission"), Parsed.Permission)
            || !IsSupportedPermission(Parsed.Permission))
        {
            Parsed.ResponseJson = MakeErrorResponse(
                RequestId,
                TEXT("invalid_preflight"),
                TEXT("Command preflight returned invalid command permission metadata."));
            return Parsed;
        }

        const TSharedPtr<FJsonObject>* NormalizedPayload = nullptr;
        if (!(*ResultObject)->TryGetObjectField(TEXT("normalizedPayload"), NormalizedPayload)
            || NormalizedPayload == nullptr
            || !NormalizedPayload->IsValid())
        {
            Parsed.ResponseJson = MakeErrorResponse(
                RequestId,
                TEXT("invalid_preflight"),
                TEXT("Command preflight did not return a normalized payload object."));
            return Parsed;
        }
        Parsed.PayloadSummary = WriteJsonObject(NormalizedPayload->ToSharedRef());
        constexpr int32 MaxPayloadSummaryCharacters = 1200;
        if (Parsed.PayloadSummary.Len() > MaxPayloadSummaryCharacters)
        {
            Parsed.PayloadSummary = Parsed.PayloadSummary.Left(MaxPayloadSummaryCharacters) + TEXT("...");
        }

        const TSharedPtr<FJsonObject>* ExecutionObject = nullptr;
        if (!(*ResultObject)->TryGetObjectField(TEXT("execution"), ExecutionObject)
            || ExecutionObject == nullptr
            || !ExecutionObject->IsValid()
            || !(*ExecutionObject)->TryGetStringField(TEXT("thread"), Parsed.ExecutionThread)
            || !(*ExecutionObject)->TryGetStringField(TEXT("cancellationMode"), Parsed.CancellationMode)
            || !(*ExecutionObject)->TryGetStringField(TEXT("timeoutPolicy"), Parsed.TimeoutPolicy)
            || !IsSupportedExecutionMetadata(
                Parsed.ExecutionThread,
                Parsed.CancellationMode,
                Parsed.TimeoutPolicy))
        {
            Parsed.ResponseJson = MakeErrorResponse(
                RequestId,
                TEXT("invalid_preflight"),
                TEXT("Command preflight returned unsupported execution metadata."));
            return Parsed;
        }

        Parsed.Permission = Parsed.Permission.ToLower();
        Parsed.ExecutionThread = Parsed.ExecutionThread.ToLower();
        Parsed.CancellationMode = Parsed.CancellationMode.ToLower();
        Parsed.TimeoutPolicy = Parsed.TimeoutPolicy.ToLower();
        Parsed.bSuccess = true;
        return Parsed;
    }
}

void UUnrealEditorWebUIBridge::PostMessage(const FString& Payload)
{
    if (Payload.Len() > MaxPostMessageCharacters)
    {
        UE_LOG(
            LogUnrealEditorWebUIBridge,
            Warning,
            TEXT("Discarded oversized WebUI message (%d characters; limit %d)."),
            Payload.Len(),
            MaxPostMessageCharacters);
        return;
    }

    UE_LOG(LogUnrealEditorWebUIBridge, Log, TEXT("WebUI message: %s"), *Payload);
}

void UUnrealEditorWebUIBridge::SetEventDispatcher(TFunction<void(const FString&)> InEventDispatcher)
{
    EventDispatcher = MoveTemp(InEventDispatcher);
}

void UUnrealEditorWebUIBridge::BeginDocumentSession(const FString& SecurityScope)
{
    static_cast<void>(SecurityScope);
    bool bHadCooperativeTasks = false;

    {
        FScopeLock Lock(&TasksCriticalSection);
        CurrentDocumentSessionId = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens);

        for (const TPair<FString, FUnrealEditorWebUITask>& Pair : Tasks)
        {
            if (Pair.Value.Status == TEXT("running")
                && IsCooperativeExecutionThread(Pair.Value.ExecutionThread))
            {
                bHadCooperativeTasks = true;
            }
        }

        // No task capability crosses a top-level document boundary. Removing
        // every old record also prevents an invisible session from filling the
        // bounded task store and blocking the replacement document.
        Tasks.Empty();
    }

    if (bHadCooperativeTasks)
    {
        CancelAllCooperativeCommands();
        StopCooperativeTickerIfIdle();
    }

    ResetPrivilegedCommandApprovals();
}

void UUnrealEditorWebUIBridge::ResetPrivilegedCommandApprovals()
{
    // Privileged approvals are deliberately single-use and are never cached.
}

#if WITH_DEV_AUTOMATION_TESTS
FString UUnrealEditorWebUIBridge::TestOnlyCreateTask(
    const FString& RequestJson,
    const FString& Status,
    const FString& ExecutionThread,
    const FString& CancellationMode,
    const FString& TimeoutPolicy,
    const FDateTime& CreatedAt,
    int32 Progress,
    int32 CooperativeTotalSteps)
{
    const FString TaskId = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens);

    FScopeLock Lock(&TasksCriticalSection);
    FUnrealEditorWebUITask& Task = Tasks.Add(TaskId);
    Task.SessionId = CurrentDocumentSessionId;
    Task.RequestJson = RequestJson;
    ParseJsonObjectOrEmpty(RequestJson)->TryGetStringField(TEXT("command"), Task.CommandName);
    Task.Status = Status;
    Task.ExecutionThread = ExecutionThread;
    Task.CancellationMode = CancellationMode;
    Task.TimeoutPolicy = TimeoutPolicy;
    Task.Progress = Progress;
    Task.CooperativeStep = 0;
    Task.CooperativeTotalSteps = CooperativeTotalSteps;
    Task.CreatedAt = CreatedAt;
    Task.UpdatedAt = CreatedAt;
    ApplyTaskLifecycleForStatusLocked(Task);
    return TaskId;
}

bool UUnrealEditorWebUIBridge::TestOnlyTickCooperativeTasks(float DeltaTime)
{
    return TickCooperativeTasks(DeltaTime);
}

FString UUnrealEditorWebUIBridge::TestOnlyValidatePreflightResponse(
    const FString& RequestId,
    const FString& PreflightJson) const
{
    const FCommandPreflight Preflight = ParseCommandPreflight(RequestId, PreflightJson);
    if (!Preflight.bSuccess)
    {
        return Preflight.ResponseJson;
    }

    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("command"), Preflight.CommandName);
    Result->SetStringField(TEXT("permission"), Preflight.Permission);
    Result->SetStringField(TEXT("thread"), Preflight.ExecutionThread);
    Result->SetStringField(TEXT("cancellationMode"), Preflight.CancellationMode);
    Result->SetStringField(TEXT("timeoutPolicy"), Preflight.TimeoutPolicy);
    Result->SetStringField(TEXT("payloadSummary"), Preflight.PayloadSummary);
    return MakeBoundedSuccessResponse(RequestId, Result);
}

FString UUnrealEditorWebUIBridge::TestOnlyBuildProjectStorageNamespace(
    const FString& ProjectIdentity) const
{
    return BuildProjectStorageNamespace(ProjectIdentity);
}

void UUnrealEditorWebUIBridge::TestOnlyCompleteTaskWithResponse(
    const FString& TaskId,
    const FString& ResponseJson)
{
    UpdateTaskStatus(TaskId, TEXT("completed"), ResponseJson, 100, TEXT("Task completed."));
}

int32 UUnrealEditorWebUIBridge::TestOnlyStoredTaskCount() const
{
    FScopeLock Lock(&TasksCriticalSection);
    return Tasks.Num();
}
#endif

FString UUnrealEditorWebUIBridge::ExecuteCommand(const FString& RequestJson)
{
    if (RequestJson.IsEmpty())
    {
        return MakeErrorResponse(FString(), TEXT("invalid_request"), TEXT("Request JSON cannot be empty."));
    }
    if (RequestJson.Len() > MaxRequestJsonCharacters)
    {
        return MakeErrorResponse(
            FString(),
            TEXT("request_too_large"),
            FString::Printf(
                TEXT("Request JSON exceeds the maximum size of %d characters."),
                MaxRequestJsonCharacters));
    }

    const FString RequestId = ExtractRequestId(RequestJson);

    const FCommandPreflight Preflight = ParseCommandPreflight(
        RequestId,
        ExecuteRegistryFunction(RequestJson, TEXT("inspect_command")));
    if (!Preflight.bSuccess)
    {
        return Preflight.ResponseJson;
    }

    if (IsCooperativeExecutionThread(Preflight.ExecutionThread))
    {
        return MakeErrorResponse(
            RequestId,
            TEXT("task_required"),
            FString::Printf(
                TEXT("Command \"%s\" must be started as a cooperative task."),
                *Preflight.CommandName));
    }

    if (IsPrivilegedPermission(Preflight.Permission))
    {
        if (!ConfirmPrivilegedCommand(
                Preflight.CommandName,
                Preflight.Permission,
                Preflight.PayloadSummary))
        {
            return MakeErrorResponse(
                RequestId,
                TEXT("permission_denied"),
                FString::Printf(
                    TEXT("User declined %s command: %s"),
                    *Preflight.Permission,
                    *Preflight.CommandName));
        }
    }

    return ExecuteRegistryFunction(
        RequestJson,
        TEXT("execute_command"),
        MakePermissionPolicyJson(Preflight.CommandName, Preflight.Permission));
}

FString UUnrealEditorWebUIBridge::ExecuteRegistryFunction(
    const FString& RequestJson,
    const FString& FunctionName,
    const FString& PermissionPolicyJson) const
{
    if (RequestJson.Len() > MaxRequestJsonCharacters)
    {
        return MakeErrorResponse(
            FString(),
            TEXT("request_too_large"),
            FString::Printf(
                TEXT("Registry request exceeds the maximum size of %d characters."),
                MaxRequestJsonCharacters));
    }
    if (PermissionPolicyJson.Len() > MaxPermissionPolicyCharacters)
    {
        return MakeErrorResponse(
            ExtractRequestId(RequestJson),
            TEXT("permission_policy_too_large"),
            TEXT("Permission policy exceeds the bridge size limit."));
    }

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

    const FString EncodedPythonDir = EncodeBase64Utf8(PythonDir);
    const FString EncodedRequestJson = EncodeBase64Utf8(RequestJson);
    const FString EncodedFunctionName = EncodeBase64Utf8(FunctionName);
    const FString EncodedPermissionPolicyJson = EncodeBase64Utf8(PermissionPolicyJson);

    const FString PythonExpression = FString::Printf(TEXT("(lambda sys, python_dir: (sys.path.insert(0, python_dir) if python_dir not in sys.path else None, __import__('unreal_editor_webui_bridge_entry').dispatch_for_unreal('%s', '%s', '%s'))[1])(__import__('sys'), __import__('base64').b64decode('%s').decode('utf-8'))"),
        *EncodedFunctionName,
        *EncodedRequestJson,
        *EncodedPermissionPolicyJson,
        *EncodedPythonDir);
    FPythonCommandEx PythonCommand;
    PythonCommand.ExecutionMode = EPythonCommandExecutionMode::EvaluateStatement;
    PythonCommand.FileExecutionScope = EPythonFileExecutionScope::Public;
    PythonCommand.Command = PythonExpression;

    const bool bExecuted = PythonPlugin->ExecPythonCommandEx(PythonCommand);
    if (!bExecuted)
    {
        UE_LOG(LogUnrealEditorWebUIBridge, Error, TEXT("Python command registry execution failed: %s"), *PythonCommand.CommandResult);
        return MakeErrorResponse(RequestId, TEXT("python_execution_failed"), TEXT("Failed to execute the Python command registry."));
    }

    if (PythonCommand.CommandResult.IsEmpty())
    {
        return MakeErrorResponse(RequestId, TEXT("missing_response"), TEXT("Python command registry did not return a response."));
    }

    if (Utf8ByteLength(PythonCommand.CommandResult) > MaxResponseJsonUtf8Bytes)
    {
        return MakeErrorResponse(
            RequestId,
            TEXT("response_too_large"),
            FString::Printf(
                TEXT("Registry response exceeds the maximum size of %d UTF-8 bytes."),
                MaxResponseJsonUtf8Bytes));
    }

    return PythonCommand.CommandResult;
}

FString UUnrealEditorWebUIBridge::StartCommand(const FString& RequestJson)
{
    if (RequestJson.IsEmpty())
    {
        return MakeErrorResponse(FString(), TEXT("invalid_request"), TEXT("Request JSON cannot be empty."));
    }
    if (RequestJson.Len() > MaxRequestJsonCharacters)
    {
        return MakeErrorResponse(
            FString(),
            TEXT("request_too_large"),
            FString::Printf(
                TEXT("Request JSON exceeds the maximum size of %d characters."),
                MaxRequestJsonCharacters));
    }

    const FCommandPreflight Preflight = ParseCommandPreflight(
        ExtractRequestId(RequestJson),
        ExecuteRegistryFunction(RequestJson, TEXT("inspect_command")));
    if (!Preflight.bSuccess)
    {
        return Preflight.ResponseJson;
    }

    if (IsPrivilegedPermission(Preflight.Permission)
        && !ConfirmPrivilegedCommand(
            Preflight.CommandName,
            Preflight.Permission,
            Preflight.PayloadSummary))
    {
        return MakeErrorResponse(
            ExtractRequestId(RequestJson),
            TEXT("permission_denied"),
            FString::Printf(
                TEXT("User declined %s command: %s"),
                *Preflight.Permission,
                *Preflight.CommandName));
    }

    const FString PermissionPolicyJson = MakePermissionPolicyJson(
        Preflight.CommandName,
        Preflight.Permission);

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
        Task.SessionId = CurrentDocumentSessionId;
        Task.CommandName = Preflight.CommandName;
        Task.RequestJson = RequestJson;
        Task.Status = TEXT("queued");
        Task.ExecutionThread = Preflight.ExecutionThread;
        Task.CancellationMode = Preflight.CancellationMode;
        Task.TimeoutPolicy = Preflight.TimeoutPolicy;
        Task.PermissionPolicyJson = PermissionPolicyJson;
        Task.Progress = 0;
        Task.CreatedAt = Now;
        Task.UpdatedAt = Now;
        ApplyTaskLifecycleForStatusLocked(Task);
        AppendTaskLogLocked(Task, TEXT("Task queued."));
    }
    BroadcastTaskEvent(TaskId, TEXT("queued"), 0, TEXT("Task queued."));

    if (IsCooperativeExecutionThread(Preflight.ExecutionThread))
    {
        StartCooperativeTask(TaskId, RequestJson, PermissionPolicyJson);
    }
    else
    {
        const TWeakObjectPtr<UUnrealEditorWebUIBridge> WeakThis(this);
        AsyncTask(ENamedThreads::GameThread, [WeakThis, TaskId, RequestJson, PermissionPolicyJson]()
        {
            if (WeakThis.IsValid())
            {
                WeakThis->RunTask(TaskId, RequestJson, PermissionPolicyJson);
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
    return MakeBoundedSuccessResponse(ExtractRequestId(RequestJson), Result);
}

FString UUnrealEditorWebUIBridge::GetTask(const FString& TaskId) const
{
    if (TaskId.IsEmpty() || TaskId.Len() > MaxTaskIdCharacters)
    {
        return MakeErrorResponse(FString(), TEXT("invalid_task_id"), TEXT("Task id is invalid."));
    }

    FScopeLock Lock(&TasksCriticalSection);
    const FUnrealEditorWebUITask* Task = Tasks.Find(TaskId);
    if (Task == nullptr || !IsTaskVisibleInCurrentSessionLocked(*Task))
    {
        return MakeErrorResponse(FString(), TEXT("task_not_found"), FString::Printf(TEXT("Task not found: %s"), *TaskId));
    }

    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    WriteTaskResultFields(Result, TaskId, *Task);

    return MakeBoundedSuccessResponse(FString(), Result);
}

FString UUnrealEditorWebUIBridge::ListTasks() const
{
    FScopeLock Lock(&TasksCriticalSection);

    TArray<FString> TaskIds;
    for (const TPair<FString, FUnrealEditorWebUITask>& Pair : Tasks)
    {
        if (IsTaskVisibleInCurrentSessionLocked(Pair.Value))
        {
            TaskIds.Add(Pair.Key);
        }
    }
    TaskIds.Sort([this](const FString& Left, const FString& Right)
    {
        return Tasks.FindChecked(Left).CreatedAt > Tasks.FindChecked(Right).CreatedAt;
    });

    TArray<TSharedPtr<FJsonValue>> TaskValues;
    TaskValues.Reserve(TaskIds.Num());
    for (const FString& TaskId : TaskIds)
    {
        const TSharedRef<FJsonObject> TaskObject = MakeShared<FJsonObject>();
        WriteTaskSummaryFields(TaskObject, TaskId, Tasks.FindChecked(TaskId));
        TaskValues.Add(MakeShared<FJsonValueObject>(TaskObject));
    }

    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetArrayField(TEXT("tasks"), TaskValues);
    return MakeBoundedSuccessResponse(FString(), Result);
}

FString UUnrealEditorWebUIBridge::RemoveTask(const FString& TaskId)
{
    if (TaskId.IsEmpty() || TaskId.Len() > MaxTaskIdCharacters)
    {
        return MakeErrorResponse(FString(), TEXT("invalid_task_id"), TEXT("Task id is invalid."));
    }

    FScopeLock Lock(&TasksCriticalSection);
    const FUnrealEditorWebUITask* Task = Tasks.Find(TaskId);
    if (Task == nullptr || !IsTaskVisibleInCurrentSessionLocked(*Task))
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
    return MakeBoundedSuccessResponse(FString(), Result);
}

FString UUnrealEditorWebUIBridge::CancelTask(const FString& TaskId)
{
    if (TaskId.IsEmpty() || TaskId.Len() > MaxTaskIdCharacters)
    {
        return MakeErrorResponse(FString(), TEXT("invalid_task_id"), TEXT("Task id is invalid."));
    }

    FString Status;
    bool bCancelled = false;
    {
        FScopeLock Lock(&TasksCriticalSection);
        FUnrealEditorWebUITask* Task = Tasks.Find(TaskId);
        if (Task == nullptr || !IsTaskVisibleInCurrentSessionLocked(*Task))
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
    return MakeBoundedSuccessResponse(FString(), Result);
}

FString UUnrealEditorWebUIBridge::GetWebUISettings() const
{
    return MakeBoundedSuccessResponse(FString(), ParseJsonObjectOrEmpty(UnrealEditorWebUISettings::ToJson(UnrealEditorWebUISettings::Load())));
}

FString UUnrealEditorWebUIBridge::GetProjectContext() const
{
    FString ProjectIdentity = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
    FPaths::NormalizeDirectoryName(ProjectIdentity);
#if PLATFORM_WINDOWS
    ProjectIdentity = ProjectIdentity.ToLower();
#endif
    if (ProjectIdentity.IsEmpty())
    {
        ProjectIdentity = FString(FApp::GetProjectName());
    }

    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetNumberField(TEXT("protocolVersion"), 1);
    Result->SetStringField(TEXT("projectName"), FString(FApp::GetProjectName()));
    Result->SetStringField(
        TEXT("storageNamespace"),
        BuildProjectStorageNamespace(ProjectIdentity));
    return MakeBoundedSuccessResponse(FString(), Result);
}

FString UUnrealEditorWebUIBridge::SetWebUISettings(const FString& SettingsJson)
{
    if (SettingsJson.Len() > MaxSettingsJsonCharacters)
    {
        return MakeErrorResponse(
            FString(),
            TEXT("request_too_large"),
            FString::Printf(
                TEXT("Settings JSON exceeds the maximum size of %d characters."),
                MaxSettingsJsonCharacters));
    }

    FUnrealEditorWebUISettings Settings;
    FString Error;
    if (!UnrealEditorWebUISettings::FromJson(SettingsJson, Settings, Error))
    {
        return MakeErrorResponse(FString(), TEXT("invalid_settings"), Error);
    }

    FString SettingsSummary = UnrealEditorWebUISettings::ToJson(Settings);
    constexpr int32 MaxSettingsSummaryCharacters = 1200;
    if (SettingsSummary.Len() > MaxSettingsSummaryCharacters)
    {
        SettingsSummary = SettingsSummary.Left(MaxSettingsSummaryCharacters) + TEXT("...");
    }
    if (!ConfirmPrivilegedCommand(TEXT("settings.update"), TEXT("write"), SettingsSummary))
    {
        return MakeErrorResponse(
            FString(),
            TEXT("permission_denied"),
            TEXT("User declined the WebUI settings update."));
    }

    UnrealEditorWebUISettings::Save(Settings);
    return MakeBoundedSuccessResponse(FString(), ParseJsonObjectOrEmpty(UnrealEditorWebUISettings::ToJson(Settings)));
}

bool UUnrealEditorWebUIBridge::ConfirmPrivilegedCommand(
    const FString& CommandName,
    const FString& Permission,
    const FString& PayloadSummary) const
{
    const FText Title = NSLOCTEXT("UnrealEditorWebUIBridge", "ConfirmPrivilegedCommandTitle", "Confirm WebUI Command");
    const FText Message = FText::Format(
        NSLOCTEXT(
            "UnrealEditorWebUIBridge",
            "ConfirmPrivilegedCommandMessage",
            "Run {0} command \"{1}\" from the WebUI?\n\nNormalized payload:\n{2}\n\nThis approval applies only to this invocation. Only continue if you trust the currently loaded page."),
        FText::FromString(Permission),
        FText::FromString(CommandName),
        FText::FromString(PayloadSummary));

    return FMessageDialog::Open(EAppMsgType::YesNo, Message, Title) == EAppReturnType::Yes;
}

bool UUnrealEditorWebUIBridge::IsTaskVisibleInCurrentSessionLocked(
    const FUnrealEditorWebUITask& Task) const
{
    return Task.SessionId == CurrentDocumentSessionId;
}

void UUnrealEditorWebUIBridge::CancelAllCooperativeCommands() const
{
    const FString CleanupResponse = ExecuteRegistryFunction(
        TEXT("{}"),
        TEXT("cancel_all_cooperative_commands"));
    const TSharedRef<FJsonObject> CleanupEnvelope = ParseJsonObjectOrEmpty(CleanupResponse);
    bool bOk = false;
    if (!CleanupEnvelope->TryGetBoolField(TEXT("ok"), bOk) || !bOk)
    {
        UE_LOG(
            LogUnrealEditorWebUIBridge,
            Warning,
            TEXT("Failed to clean cooperative Python jobs while rotating the document session."));
    }
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

    while (Tasks.Num() >= MaxStoredTasks)
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

void UUnrealEditorWebUIBridge::StartCooperativeTask(
    const FString& TaskId,
    const FString& RequestJson,
    const FString& PermissionPolicyJson)
{
    const TSharedRef<FJsonObject> TaskPolicy = ParseJsonObjectOrEmpty(PermissionPolicyJson);
    TaskPolicy->SetStringField(TEXT("taskId"), TaskId);
    const FString StartResponseJson = ExecuteRegistryFunction(
        RequestJson,
        TEXT("start_cooperative_command"),
        WriteJsonObject(TaskPolicy));
    const auto CleanupPythonJob = [this, &RequestJson, &TaskId]()
    {
        ExecuteRegistryFunction(
            MakeCooperativeControlJson(ExtractRequestId(RequestJson), TaskId, true),
            TEXT("step_cooperative_command"));
    };

    TSharedPtr<FJsonObject> StartResponse;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(StartResponseJson);
    bool bOk = false;
    if (!FJsonSerializer::Deserialize(Reader, StartResponse)
        || !StartResponse.IsValid()
        || !StartResponse->TryGetBoolField(TEXT("ok"), bOk)
        || !bOk)
    {
        CleanupPythonJob();
        const FString FailureResponse = StartResponse.IsValid()
            ? StartResponseJson
            : MakeErrorResponse(
                ExtractRequestId(RequestJson),
                TEXT("invalid_cooperative_response"),
                TEXT("Python did not return a valid cooperative start response."));
        UpdateTaskStatus(
            TaskId,
            TEXT("failed"),
            FailureResponse,
            100,
            TEXT("Cooperative command failed to start."));
        return;
    }

    const TSharedPtr<FJsonObject>* Result = nullptr;
    FString Status;
    if (!StartResponse->TryGetObjectField(TEXT("result"), Result)
        || Result == nullptr
        || !Result->IsValid()
        || !(*Result)->TryGetStringField(TEXT("status"), Status)
        || Status != TEXT("running"))
    {
        CleanupPythonJob();
        UpdateTaskStatus(
            TaskId,
            TEXT("failed"),
            MakeErrorResponse(
                ExtractRequestId(RequestJson),
                TEXT("invalid_cooperative_response"),
                TEXT("Python returned invalid cooperative start metadata.")),
            100,
            TEXT("Cooperative command returned invalid start metadata."));
        return;
    }

    FString LogLine = TEXT("Cooperative command started.");
    (*Result)->TryGetStringField(TEXT("log"), LogLine);
    UpdateTaskStatus(TaskId, TEXT("running"), FString(), 0, LogLine);
    EnsureCooperativeTicker();
}

void UUnrealEditorWebUIBridge::EnforceTaskResponseBudgetLocked(const FString& PreserveTaskId)
{
    int64 RetainedCharacters = 0;
    for (const TPair<FString, FUnrealEditorWebUITask>& Pair : Tasks)
    {
        RetainedCharacters += Pair.Value.ResponseJson.Len();
    }

    while (RetainedCharacters > MaxRetainedTaskResponseCharacters)
    {
        FString OldestResponseTaskId;
        FDateTime OldestResponseTime = FDateTime::MaxValue();
        for (const TPair<FString, FUnrealEditorWebUITask>& Pair : Tasks)
        {
            if (Pair.Key != PreserveTaskId
                && IsFinishedTaskStatus(Pair.Value.Status)
                && !Pair.Value.ResponseJson.IsEmpty()
                && Pair.Value.UpdatedAt < OldestResponseTime)
            {
                OldestResponseTaskId = Pair.Key;
                OldestResponseTime = Pair.Value.UpdatedAt;
            }
        }

        if (OldestResponseTaskId.IsEmpty())
        {
            break;
        }

        FUnrealEditorWebUITask& EvictedTask = Tasks.FindChecked(OldestResponseTaskId);
        RetainedCharacters -= EvictedTask.ResponseJson.Len();
        EvictedTask.ResponseJson.Reset();
        AppendTaskLogLocked(
            EvictedTask,
            TEXT("Full response evicted after the bridge reached its retained-response memory budget."));
    }
}

bool UUnrealEditorWebUIBridge::TickCooperativeTasks(float DeltaTime)
{
    static_cast<void>(DeltaTime);

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
        FString RequestId;
        bool bCancellationRequested = false;
        bool bTimedOut = false;
        double TimeoutSeconds = 0.0;

        {
            FScopeLock Lock(&TasksCriticalSection);
            const FUnrealEditorWebUITask* Task = Tasks.Find(TaskId);
            if (Task == nullptr || Task->Status != TEXT("running"))
            {
                continue;
            }

            RequestId = ExtractRequestId(Task->RequestJson);
            bCancellationRequested = Task->bCancellationRequested;
            TimeoutSeconds = ParseTimeoutSeconds(Task->TimeoutPolicy);
            bTimedOut = TimeoutSeconds > 0.0
                && (FDateTime::UtcNow() - Task->CreatedAt).GetTotalSeconds() >= TimeoutSeconds;
        }

        const bool bCleanupRequested = bCancellationRequested || bTimedOut;
        const auto CleanupPythonJob = [this, &RequestId, &TaskId]()
        {
            ExecuteRegistryFunction(
                MakeCooperativeControlJson(RequestId, TaskId, true),
                TEXT("step_cooperative_command"));
        };
        const FString ControlJson = MakeCooperativeControlJson(
            RequestId,
            TaskId,
            bCleanupRequested);
        const FString StepResponseJson = ExecuteRegistryFunction(
            ControlJson,
            TEXT("step_cooperative_command"));

        if (bTimedOut)
        {
            const FString LogLine = FString::Printf(
                TEXT("Task timed out after %.2f second(s); Python state was cleaned up."),
                TimeoutSeconds);
            UpdateTaskStatus(
                TaskId,
                TEXT("timed_out"),
                MakeErrorResponse(RequestId, TEXT("task_timed_out"), LogLine),
                100,
                LogLine);
            continue;
        }

        if (bCancellationRequested)
        {
            UpdateTaskStatus(
                TaskId,
                TEXT("cancelled"),
                FString(),
                100,
                TEXT("Cooperative task cancelled; Python state was cleaned up."));
            continue;
        }

        TSharedPtr<FJsonObject> StepResponse;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(StepResponseJson);
        bool bOk = false;
        if (!FJsonSerializer::Deserialize(Reader, StepResponse)
            || !StepResponse.IsValid()
            || !StepResponse->TryGetBoolField(TEXT("ok"), bOk)
            || !bOk)
        {
            CleanupPythonJob();
            const FString FailureResponse = StepResponse.IsValid()
                ? StepResponseJson
                : MakeErrorResponse(
                    RequestId,
                    TEXT("invalid_cooperative_response"),
                    TEXT("Python did not return a valid cooperative step response."));
            UpdateTaskStatus(
                TaskId,
                TEXT("failed"),
                FailureResponse,
                100,
                TEXT("Cooperative command failed while stepping."));
            continue;
        }

        const TSharedPtr<FJsonObject>* Result = nullptr;
        FString Status;
        if (!StepResponse->TryGetObjectField(TEXT("result"), Result)
            || Result == nullptr
            || !Result->IsValid()
            || !(*Result)->TryGetStringField(TEXT("status"), Status))
        {
            CleanupPythonJob();
            UpdateTaskStatus(
                TaskId,
                TEXT("failed"),
                MakeErrorResponse(
                    RequestId,
                    TEXT("invalid_cooperative_response"),
                    TEXT("Python returned invalid cooperative step metadata.")),
                100,
                TEXT("Cooperative command returned invalid step metadata."));
            continue;
        }

        FString LogLine;
        (*Result)->TryGetStringField(TEXT("log"), LogLine);
        if (Status == TEXT("running"))
        {
            double ProgressValue = 0.0;
            if (!(*Result)->TryGetNumberField(TEXT("progress"), ProgressValue)
                || !FMath::IsFinite(ProgressValue)
                || ProgressValue < 0.0
                || ProgressValue >= 100.0)
            {
                CleanupPythonJob();
                UpdateTaskStatus(
                    TaskId,
                    TEXT("failed"),
                    MakeErrorResponse(
                        RequestId,
                        TEXT("invalid_cooperative_response"),
                        TEXT("Python returned invalid cooperative progress.")),
                    100,
                    TEXT("Cooperative command returned invalid progress."));
                continue;
            }

            UpdateTaskStatus(
                TaskId,
                TEXT("running"),
                FString(),
                FMath::RoundToInt(ProgressValue),
                LogLine);
            continue;
        }

        if (Status == TEXT("completed"))
        {
            const TSharedPtr<FJsonObject>* CommandResponse = nullptr;
            bool bCommandOk = false;
            if (!(*Result)->TryGetObjectField(TEXT("commandResponse"), CommandResponse)
                || CommandResponse == nullptr
                || !CommandResponse->IsValid()
                || !(*CommandResponse)->TryGetBoolField(TEXT("ok"), bCommandOk))
            {
                CleanupPythonJob();
                UpdateTaskStatus(
                    TaskId,
                    TEXT("failed"),
                    MakeErrorResponse(
                        RequestId,
                        TEXT("invalid_cooperative_response"),
                        TEXT("Completed cooperative command omitted its command response.")),
                    100,
                    TEXT("Cooperative command returned an invalid completion response."));
                continue;
            }

            const FString CommandResponseJson = WriteJsonObject((*CommandResponse).ToSharedRef());
            UpdateTaskStatus(
                TaskId,
                bCommandOk ? TEXT("completed") : TEXT("failed"),
                CommandResponseJson,
                100,
                LogLine.IsEmpty()
                    ? (bCommandOk ? TEXT("Task completed.") : TEXT("Task failed."))
                    : LogLine);
            continue;
        }

        if (Status == TEXT("cancelled"))
        {
            UpdateTaskStatus(TaskId, TEXT("cancelled"), FString(), 100, LogLine);
            continue;
        }

        CleanupPythonJob();
        UpdateTaskStatus(
            TaskId,
            TEXT("failed"),
            MakeErrorResponse(
                RequestId,
                TEXT("invalid_cooperative_response"),
                FString::Printf(TEXT("Unsupported cooperative status: %s"), *Status)),
            100,
            TEXT("Cooperative command returned an unsupported status."));
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

void UUnrealEditorWebUIBridge::RunTask(
    const FString TaskId,
    const FString RequestJson,
    const FString PermissionPolicyJson)
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

    // StartCommand already performed the single-use native authorization. Execute
    // the immutable queued request with only its exact command/permission policy.
    const FString ResponseJson = ExecuteRegistryFunction(
        RequestJson,
        TEXT("execute_command"),
        PermissionPolicyJson);
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
    FString EffectiveStatus = Status;
    FString EffectiveResponseJson = ResponseJson;
    int32 EffectiveProgress = Progress;
    FString EffectiveLogLine = LogLine;
    {
        FScopeLock Lock(&TasksCriticalSection);
        if (FUnrealEditorWebUITask* Task = Tasks.Find(TaskId))
        {
            if (!EffectiveResponseJson.IsEmpty()
                && Utf8ByteLength(EffectiveResponseJson) > MaxTaskResponseJsonUtf8Bytes)
            {
                EffectiveStatus = TEXT("failed");
                EffectiveProgress = 100;
                EffectiveLogLine = TEXT("Task response exceeded the bounded task-detail limit.");
                EffectiveResponseJson = MakeErrorResponse(
                    ExtractRequestId(Task->RequestJson),
                    TEXT("response_too_large"),
                    FString::Printf(
                        TEXT("Task response exceeds the maximum size of %d UTF-8 bytes."),
                        MaxTaskResponseJsonUtf8Bytes));
            }

            Task->Status = EffectiveStatus;
            Task->UpdatedAt = FDateTime::UtcNow();
            if (EffectiveProgress != INDEX_NONE)
            {
                Task->Progress = FMath::Clamp(EffectiveProgress, 0, 100);
            }
            if (!EffectiveResponseJson.IsEmpty())
            {
                Task->ResponseJson = EffectiveResponseJson;
            }
            ApplyTaskLifecycleForStatusLocked(*Task);
            AppendTaskLogLocked(*Task, EffectiveLogLine);
            if (!EffectiveResponseJson.IsEmpty())
            {
                EnforceTaskResponseBudgetLocked(TaskId);
            }
        }
    }

    BroadcastTaskEvent(TaskId, EffectiveStatus, EffectiveProgress, EffectiveLogLine);
}

void UUnrealEditorWebUIBridge::BroadcastTaskEvent(
    const FString& TaskId,
    const FString& Status,
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
        const FUnrealEditorWebUITask* Task = Tasks.Find(TaskId);
        if (Task == nullptr || !IsTaskVisibleInCurrentSessionLocked(*Task))
        {
            return;
        }
        Root->SetBoolField(TEXT("cancellable"), Task->bCancellable);
        Root->SetStringField(TEXT("cancellationMode"), Task->CancellationMode);
        Root->SetStringField(TEXT("executionThread"), Task->ExecutionThread);
        Root->SetStringField(TEXT("timeoutPolicy"), Task->TimeoutPolicy);
        Root->SetStringField(TEXT("message"), Task->StatusMessage);
    }
    if (Progress != INDEX_NONE)
    {
        Root->SetNumberField(TEXT("progress"), FMath::Clamp(Progress, 0, 100));
    }
    if (!LogLine.IsEmpty())
    {
        Root->SetStringField(
            TEXT("log"),
            LogLine.Len() > MaxTaskLogLineCharacters
                ? LogLine.Left(MaxTaskLogLineCharacters) + TEXT("...")
                : LogLine);
    }
    const FString EventJson = WriteJsonObject(Root);
    if (Utf8ByteLength(EventJson) > MaxTaskEventJsonUtf8Bytes)
    {
        UE_LOG(
            LogUnrealEditorWebUIBridge,
            Warning,
            TEXT("Discarded oversized task event for %s."),
            *TaskId);
        return;
    }
    EventDispatcher(EventJson);
}
