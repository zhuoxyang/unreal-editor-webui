#if WITH_DEV_AUTOMATION_TESTS

#include "UnrealEditorWebUIBridge.h"

#include "Dom/JsonObject.h"
#include "Misc/AutomationTest.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace
{
    FString MakeRequestJson(const FString& CommandName = TEXT("demo.longRun"), int32 Steps = 2)
    {
        return FString::Printf(
            TEXT("{\"id\":\"req-test\",\"command\":\"%s\",\"payload\":{\"steps\":%d}}"),
            *CommandName,
            Steps);
    }

    FString MakePreflightJson(
        const FString& ExecutionThread = TEXT("editor_game_thread"),
        const FString& CancellationMode = TEXT("queued_only"),
        const FString& TimeoutPolicy = TEXT("none"))
    {
        return FString::Printf(
            TEXT("{\"id\":\"req-test\",\"ok\":true,\"result\":{")
            TEXT("\"command\":\"system.ping\",\"permission\":\"read\",")
            TEXT("\"normalizedPayload\":{\"steps\":2},")
            TEXT("\"execution\":{\"thread\":\"%s\",\"cancellationMode\":\"%s\",\"timeoutPolicy\":\"%s\"}}}"),
            *ExecutionThread,
            *CancellationMode,
            *TimeoutPolicy);
    }

    TSharedPtr<FJsonObject> ParseJsonObject(const FString& Json)
    {
        TSharedPtr<FJsonObject> Object;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
        FJsonSerializer::Deserialize(Reader, Object);
        return Object;
    }

    TSharedPtr<FJsonObject> ParseResultObject(const FString& ResponseJson)
    {
        const TSharedPtr<FJsonObject> Response = ParseJsonObject(ResponseJson);
        if (!Response.IsValid())
        {
            return nullptr;
        }

        const TSharedPtr<FJsonValue> ResultValue = Response->TryGetField(TEXT("result"));
        return ResultValue.IsValid() ? ResultValue->AsObject() : nullptr;
    }

    FString GetResponseErrorCode(const FString& ResponseJson)
    {
        const TSharedPtr<FJsonObject> Response = ParseJsonObject(ResponseJson);
        if (!Response.IsValid())
        {
            return FString();
        }

        const TSharedPtr<FJsonObject>* Error = nullptr;
        if (Response->TryGetObjectField(TEXT("error"), Error) && Error != nullptr && Error->IsValid())
        {
            FString Code;
            (*Error)->TryGetStringField(TEXT("code"), Code);
            return Code;
        }

        return FString();
    }

    FString GetTaskStatus(UUnrealEditorWebUIBridge* Bridge, const FString& TaskId)
    {
        const TSharedPtr<FJsonObject> Result = ParseResultObject(Bridge->GetTask(TaskId));
        if (!Result.IsValid())
        {
            return FString();
        }

        FString Status;
        Result->TryGetStringField(TEXT("status"), Status);
        return Status;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUnrealEditorWebUIPackagedRegistryPingTest,
    "UnrealEditorWebUI.Bridge.PackagedRegistryPing",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUnrealEditorWebUIPackagedRegistryPingTest::RunTest(const FString& Parameters)
{
    static_cast<void>(Parameters);

    UUnrealEditorWebUIBridge* Bridge = NewObject<UUnrealEditorWebUIBridge>();
    const FString ResponseJson = Bridge->ExecuteCommand(
        TEXT("{\"id\":\"packaged-registry-smoke\",\"command\":\"system.ping\",")
        TEXT("\"payload\":{\"source\":\"packaged-registry-smoke\"}}"));
    const TSharedPtr<FJsonObject> Response = ParseJsonObject(ResponseJson);

    TestTrue(TEXT("Packaged bridge ping returns a JSON object"), Response.IsValid());
    if (!Response.IsValid())
    {
        return false;
    }

    bool bOk = false;
    TestTrue(TEXT("Packaged bridge ping includes a boolean ok field"), Response->TryGetBoolField(TEXT("ok"), bOk));
    TestTrue(*FString::Printf(TEXT("Packaged bridge ping succeeds: %s"), *ResponseJson), bOk);
    TestEqual(
        TEXT("Packaged bridge ping preserves the request id"),
        Response->GetStringField(TEXT("id")),
        FString(TEXT("packaged-registry-smoke")));

    const TSharedPtr<FJsonObject> Result = ParseResultObject(ResponseJson);
    TestTrue(TEXT("Packaged bridge ping includes a result object"), Result.IsValid());
    if (Result.IsValid())
    {
        TestEqual(TEXT("Packaged Python registry responds with pong"), Result->GetStringField(TEXT("message")), FString(TEXT("pong")));

        const TSharedPtr<FJsonObject>* Echo = nullptr;
        TestTrue(TEXT("Packaged Python registry returns the request payload"), Result->TryGetObjectField(TEXT("echo"), Echo));
        if (Echo != nullptr && Echo->IsValid())
        {
            TestEqual(
                TEXT("Packaged Python registry round-trips the payload"),
                (*Echo)->GetStringField(TEXT("source")),
                FString(TEXT("packaged-registry-smoke")));
        }
    }

    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUnrealEditorWebUIBridgePreflightValidationTest,
    "UnrealEditorWebUI.Bridge.PreflightValidation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUnrealEditorWebUIBridgePreflightValidationTest::RunTest(const FString& Parameters)
{
    static_cast<void>(Parameters);

    UUnrealEditorWebUIBridge* Bridge = NewObject<UUnrealEditorWebUIBridge>();
    const TSharedPtr<FJsonObject> DefaultResult = ParseResultObject(
        Bridge->TestOnlyValidatePreflightResponse(TEXT("req-test"), MakePreflightJson()));
    TestTrue(TEXT("Default execution metadata is accepted"), DefaultResult.IsValid());
    if (DefaultResult.IsValid())
    {
        TestEqual(
            TEXT("Default execution thread is normalized"),
            DefaultResult->GetStringField(TEXT("thread")),
            FString(TEXT("editor_game_thread")));
        TestEqual(
            TEXT("Normalized payload is retained for the native approval prompt"),
            DefaultResult->GetStringField(TEXT("payloadSummary")),
            FString(TEXT("{\"steps\":2}")));
    }

    const TSharedPtr<FJsonObject> CooperativeResult = ParseResultObject(
        Bridge->TestOnlyValidatePreflightResponse(
            TEXT("req-test"),
            MakePreflightJson(TEXT("EDITOR_TICK"), TEXT("COOPERATIVE"), TEXT("SECONDS:10"))));
    TestTrue(TEXT("Cooperative execution metadata is accepted"), CooperativeResult.IsValid());
    if (CooperativeResult.IsValid())
    {
        TestEqual(
            TEXT("Cooperative timeout is normalized"),
            CooperativeResult->GetStringField(TEXT("timeoutPolicy")),
            FString(TEXT("seconds:10")));
    }

    const TArray<TPair<FString, FString>> InvalidPreflights = {
        {TEXT("non-JSON response"), TEXT("not json")},
        {TEXT("missing ok"), TEXT("{\"id\":\"req-test\"}")},
        {TEXT("wrong ok type"), TEXT("{\"id\":\"req-test\",\"ok\":\"true\"}")},
        {TEXT("missing error envelope"), TEXT("{\"id\":\"req-test\",\"ok\":false}")},
        {TEXT("missing result"), TEXT("{\"id\":\"req-test\",\"ok\":true}")},
        {TEXT("wrong result type"), TEXT("{\"id\":\"req-test\",\"ok\":true,\"result\":[]}")},
        {TEXT("missing execution"), TEXT("{\"id\":\"req-test\",\"ok\":true,\"result\":{\"command\":\"system.ping\",\"permission\":\"read\"}}")},
        {TEXT("unknown thread"), MakePreflightJson(TEXT("background"), TEXT("queued_only"), TEXT("none"))},
        {TEXT("unknown cancellation"), MakePreflightJson(TEXT("editor_tick"), TEXT("interrupt"), TEXT("none"))},
        {TEXT("incompatible game-thread cancellation"), MakePreflightJson(TEXT("editor_game_thread"), TEXT("cooperative"), TEXT("none"))},
        {TEXT("incompatible game-thread timeout"), MakePreflightJson(TEXT("editor_game_thread"), TEXT("queued_only"), TEXT("seconds:10"))},
        {TEXT("zero timeout"), MakePreflightJson(TEXT("editor_tick"), TEXT("cooperative"), TEXT("seconds:0"))},
        {TEXT("negative timeout"), MakePreflightJson(TEXT("editor_tick"), TEXT("cooperative"), TEXT("seconds:-1"))},
        {TEXT("non-finite timeout"), MakePreflightJson(TEXT("editor_tick"), TEXT("cooperative"), TEXT("seconds:nan"))},
        {TEXT("trailing timeout text"), MakePreflightJson(TEXT("editor_tick"), TEXT("cooperative"), TEXT("seconds:10junk"))},
    };

    for (const TPair<FString, FString>& TestCase : InvalidPreflights)
    {
        TestEqual(
            *FString::Printf(TEXT("%s fails closed"), *TestCase.Key),
            GetResponseErrorCode(Bridge->TestOnlyValidatePreflightResponse(TEXT("req-test"), TestCase.Value)),
            FString(TEXT("invalid_preflight")));
    }

    const FString RegistryError = TEXT(
        "{\"id\":\"req-test\",\"ok\":false,\"error\":{\"code\":\"unknown_command\",\"message\":\"Unknown command\"}}");
    TestEqual(
        TEXT("Valid registry error is preserved"),
        GetResponseErrorCode(Bridge->TestOnlyValidatePreflightResponse(TEXT("req-test"), RegistryError)),
        FString(TEXT("unknown_command")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUnrealEditorWebUIBridgeCooperativeTaskTest,
    "UnrealEditorWebUI.Bridge.CooperativeTaskRequiresPythonJob",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUnrealEditorWebUIBridgeCooperativeTaskTest::RunTest(const FString& Parameters)
{
    static_cast<void>(Parameters);

    UUnrealEditorWebUIBridge* Bridge = NewObject<UUnrealEditorWebUIBridge>();
    const FString TaskId = Bridge->TestOnlyCreateTask(
        MakeRequestJson(TEXT("demo.longRun"), 2),
        TEXT("running"),
        TEXT("editor_tick"),
        TEXT("cooperative"),
        TEXT("seconds:10"),
        FDateTime::UtcNow(),
        1,
        2);

    Bridge->TestOnlyTickCooperativeTasks(0.25f);
    TestEqual(
        TEXT("C++ does not synthesize cooperative completion without a Python job"),
        GetTaskStatus(Bridge, TaskId),
        FString(TEXT("failed")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUnrealEditorWebUIBridgeCancelTaskTest,
    "UnrealEditorWebUI.Bridge.CancelTaskTransitions",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUnrealEditorWebUIBridgeCancelTaskTest::RunTest(const FString& Parameters)
{
    static_cast<void>(Parameters);

    UUnrealEditorWebUIBridge* Bridge = NewObject<UUnrealEditorWebUIBridge>();
    const FDateTime Now = FDateTime::UtcNow();
    const FString QueuedTaskId = Bridge->TestOnlyCreateTask(
        MakeRequestJson(),
        TEXT("queued"),
        TEXT("editor_game_thread"),
        TEXT("queued_only"),
        TEXT("none"),
        Now);
    const FString RunningTaskId = Bridge->TestOnlyCreateTask(
        MakeRequestJson(),
        TEXT("running"),
        TEXT("editor_tick"),
        TEXT("cooperative"),
        TEXT("seconds:10"),
        Now,
        25,
        4);

    const TSharedPtr<FJsonObject> QueuedCancel = ParseResultObject(Bridge->CancelTask(QueuedTaskId));
    TestTrue(TEXT("Queued task cancel response is valid"), QueuedCancel.IsValid());
    TestEqual(TEXT("Queued task is cancelled immediately"), GetTaskStatus(Bridge, QueuedTaskId), FString(TEXT("cancelled")));
    TestTrue(TEXT("Queued task reports cancelled"), QueuedCancel->GetBoolField(TEXT("cancelled")));

    const TSharedPtr<FJsonObject> RunningCancel = ParseResultObject(Bridge->CancelTask(RunningTaskId));
    TestTrue(TEXT("Running task cancel response is valid"), RunningCancel.IsValid());
    TestEqual(TEXT("Running cooperative task stays running until tick"), GetTaskStatus(Bridge, RunningTaskId), FString(TEXT("running")));
    TestFalse(TEXT("Running cooperative task is not immediately cancelled"), RunningCancel->GetBoolField(TEXT("cancelled")));

    Bridge->TestOnlyTickCooperativeTasks(0.25f);
    TestEqual(TEXT("Running cooperative task cancels on tick"), GetTaskStatus(Bridge, RunningTaskId), FString(TEXT("cancelled")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUnrealEditorWebUIBridgeTimeoutAndRemovalTest,
    "UnrealEditorWebUI.Bridge.TimeoutAndRemovalRules",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUnrealEditorWebUIBridgeTimeoutAndRemovalTest::RunTest(const FString& Parameters)
{
    static_cast<void>(Parameters);

    UUnrealEditorWebUIBridge* Bridge = NewObject<UUnrealEditorWebUIBridge>();
    const FString RunningTaskId = Bridge->TestOnlyCreateTask(
        MakeRequestJson(),
        TEXT("running"),
        TEXT("editor_tick"),
        TEXT("cooperative"),
        TEXT("seconds:1"),
        FDateTime::UtcNow() - FTimespan::FromSeconds(2),
        10,
        10);

    Bridge->TestOnlyTickCooperativeTasks(0.25f);
    TestEqual(TEXT("Expired cooperative task times out"), GetTaskStatus(Bridge, RunningTaskId), FString(TEXT("timed_out")));

    const FString QueuedTaskId = Bridge->TestOnlyCreateTask(
        MakeRequestJson(),
        TEXT("queued"),
        TEXT("editor_game_thread"),
        TEXT("queued_only"),
        TEXT("none"),
        FDateTime::UtcNow());
    TestEqual(TEXT("Non-terminal task removal is rejected"), GetResponseErrorCode(Bridge->RemoveTask(QueuedTaskId)), FString(TEXT("task_not_finished")));

    TestTrue(TEXT("Timed-out task can be removed"), ParseResultObject(Bridge->RemoveTask(RunningTaskId)).IsValid());
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUnrealEditorWebUIBridgeListTasksSummaryTest,
    "UnrealEditorWebUI.Bridge.ListTasksSummary",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUnrealEditorWebUIBridgeListTasksSummaryTest::RunTest(const FString& Parameters)
{
    static_cast<void>(Parameters);

    UUnrealEditorWebUIBridge* Bridge = NewObject<UUnrealEditorWebUIBridge>();
    const FString OlderTaskId = Bridge->TestOnlyCreateTask(
        MakeRequestJson(TEXT("demo.older"), 1),
        TEXT("completed"),
        TEXT("editor_game_thread"),
        TEXT("queued_only"),
        TEXT("none"),
        FDateTime::UtcNow() - FTimespan::FromSeconds(5),
        100);
    const FString NewerTaskId = Bridge->TestOnlyCreateTask(
        MakeRequestJson(TEXT("demo.newer"), 1),
        TEXT("completed"),
        TEXT("editor_game_thread"),
        TEXT("queued_only"),
        TEXT("none"),
        FDateTime::UtcNow(),
        100);

    const TSharedPtr<FJsonObject> ListResult = ParseResultObject(Bridge->ListTasks());
    TestTrue(TEXT("ListTasks response has result object"), ListResult.IsValid());

    const TArray<TSharedPtr<FJsonValue>>* Tasks = nullptr;
    TestTrue(TEXT("ListTasks includes tasks array"), ListResult->TryGetArrayField(TEXT("tasks"), Tasks));
    TestTrue(TEXT("ListTasks returns at least two tasks"), Tasks != nullptr && Tasks->Num() >= 2);
    if (Tasks != nullptr && Tasks->Num() >= 2)
    {
        TestEqual(TEXT("Newest task is listed first"), (*Tasks)[0]->AsObject()->GetStringField(TEXT("taskId")), NewerTaskId);
        TestEqual(TEXT("Older task is listed second"), (*Tasks)[1]->AsObject()->GetStringField(TEXT("taskId")), OlderTaskId);
        TestFalse(TEXT("Task summaries omit request payloads"), (*Tasks)[0]->AsObject()->HasField(TEXT("payload")));
        TestFalse(TEXT("Task summaries omit log arrays"), (*Tasks)[0]->AsObject()->HasField(TEXT("logs")));
        TestFalse(TEXT("Task summaries omit full responses"), (*Tasks)[0]->AsObject()->HasField(TEXT("responseJson")));
    }

    const TSharedPtr<FJsonObject> Detail = ParseResultObject(Bridge->GetTask(NewerTaskId));
    TestTrue(TEXT("GetTask returns task detail"), Detail.IsValid());
    if (Detail.IsValid())
    {
        TestTrue(TEXT("Task detail includes payload"), Detail->HasField(TEXT("payload")));
        TestTrue(TEXT("Task detail includes logs"), Detail->HasField(TEXT("logs")));
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUnrealEditorWebUIBridgeDocumentSessionTest,
    "UnrealEditorWebUI.Bridge.DocumentSessionIsolation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUnrealEditorWebUIBridgeDocumentSessionTest::RunTest(const FString& Parameters)
{
    static_cast<void>(Parameters);

    UUnrealEditorWebUIBridge* Bridge = NewObject<UUnrealEditorWebUIBridge>();
    Bridge->BeginDocumentSession(TEXT("http://localhost:5173"));
    const FString OldTaskId = Bridge->TestOnlyCreateTask(
        MakeRequestJson(TEXT("system.ping"), 1),
        TEXT("running"),
        TEXT("editor_game_thread"),
        TEXT("queued_only"),
        TEXT("none"),
        FDateTime::UtcNow(),
        10);

    TestTrue(TEXT("Creating session can read its task"), ParseResultObject(Bridge->GetTask(OldTaskId)).IsValid());
    Bridge->BeginDocumentSession(TEXT("http://localhost:5173"));
    TestEqual(
        TEXT("A reloaded document cannot read an earlier task"),
        GetResponseErrorCode(Bridge->GetTask(OldTaskId)),
        FString(TEXT("task_not_found")));
    TestEqual(
        TEXT("A reloaded document cannot cancel an earlier task"),
        GetResponseErrorCode(Bridge->CancelTask(OldTaskId)),
        FString(TEXT("task_not_found")));
    TestEqual(
        TEXT("Session rotation releases all old task-store capacity"),
        Bridge->TestOnlyStoredTaskCount(),
        0);

    const TSharedPtr<FJsonObject> EmptyList = ParseResultObject(Bridge->ListTasks());
    const TArray<TSharedPtr<FJsonValue>>* VisibleTasks = nullptr;
    TestTrue(TEXT("Current session task list is valid"), EmptyList.IsValid() && EmptyList->TryGetArrayField(TEXT("tasks"), VisibleTasks));
    TestEqual(TEXT("Earlier-session tasks are not listed"), VisibleTasks == nullptr ? -1 : VisibleTasks->Num(), 0);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUnrealEditorWebUIBridgeResourceLimitsTest,
    "UnrealEditorWebUI.Bridge.ResourceLimitsAndProjectContext",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUnrealEditorWebUIBridgeResourceLimitsTest::RunTest(const FString& Parameters)
{
    static_cast<void>(Parameters);

    UUnrealEditorWebUIBridge* Bridge = NewObject<UUnrealEditorWebUIBridge>();
    const FString Oversized = FString::ChrN(300 * 1024, TEXT('x'));
    TestEqual(
        TEXT("Oversized synchronous requests fail before Python execution"),
        GetResponseErrorCode(Bridge->ExecuteCommand(Oversized)),
        FString(TEXT("request_too_large")));
    TestEqual(
        TEXT("Oversized task requests fail before queuing"),
        GetResponseErrorCode(Bridge->StartCommand(Oversized)),
        FString(TEXT("request_too_large")));
    TestEqual(
        TEXT("Oversized settings fail before parsing"),
        GetResponseErrorCode(Bridge->SetWebUISettings(Oversized)),
        FString(TEXT("request_too_large")));

    const TSharedPtr<FJsonObject> FirstContext = ParseResultObject(Bridge->GetProjectContext());
    const TSharedPtr<FJsonObject> SecondContext = ParseResultObject(Bridge->GetProjectContext());
    TestTrue(TEXT("Project context is available"), FirstContext.IsValid() && SecondContext.IsValid());
    if (FirstContext.IsValid() && SecondContext.IsValid())
    {
        const FString Namespace = FirstContext->GetStringField(TEXT("storageNamespace"));
        TestTrue(TEXT("Project namespace is a non-sensitive hash"), Namespace.StartsWith(TEXT("project-")) && Namespace.Len() == 32);
        TestEqual(
            TEXT("Project namespace is stable"),
            Namespace,
            SecondContext->GetStringField(TEXT("storageNamespace")));
    }

    const FString UnicodeNamespaceA = Bridge->TestOnlyBuildProjectStorageNamespace(TEXT("C:/项目/甲"));
    const FString UnicodeNamespaceB = Bridge->TestOnlyBuildProjectStorageNamespace(TEXT("C:/项目/乙"));
    TestTrue(
        TEXT("UTF-8 project identities remain distinct"),
        UnicodeNamespaceA != UnicodeNamespaceB);
    TestTrue(
        TEXT("UTF-8 project namespace keeps the non-sensitive bounded format"),
        UnicodeNamespaceA.StartsWith(TEXT("project-")) && UnicodeNamespaceA.Len() == 32);

    const FString TaskId = Bridge->TestOnlyCreateTask(
        MakeRequestJson(TEXT("system.ping"), 1),
        TEXT("running"),
        TEXT("editor_game_thread"),
        TEXT("queued_only"),
        TEXT("none"),
        FDateTime::UtcNow(),
        10);
    Bridge->TestOnlyCompleteTaskWithResponse(
        TaskId,
        FString::ChrN(1600 * 1024, TEXT('x')));
    const TSharedPtr<FJsonObject> BoundedTask = ParseResultObject(Bridge->GetTask(TaskId));
    TestTrue(TEXT("Oversized task result is replaced with a bounded detail"), BoundedTask.IsValid());
    if (BoundedTask.IsValid())
    {
        TestEqual(
            TEXT("Oversized task result fails the task truthfully"),
            BoundedTask->GetStringField(TEXT("status")),
            FString(TEXT("failed")));
        TestTrue(
            TEXT("Bounded task detail preserves a structured size error"),
            BoundedTask->GetStringField(TEXT("responseJson")).Contains(TEXT("response_too_large")));
    }
    return true;
}

#endif
