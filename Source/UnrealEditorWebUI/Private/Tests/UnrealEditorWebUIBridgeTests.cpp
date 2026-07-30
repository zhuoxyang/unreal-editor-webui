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
    "UnrealEditorWebUI.Bridge.CooperativeTaskCompletes",
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
    TestEqual(TEXT("Task remains running after first step"), GetTaskStatus(Bridge, TaskId), FString(TEXT("running")));

    Bridge->TestOnlyTickCooperativeTasks(0.25f);
    TestEqual(TEXT("Task completes after final cooperative step"), GetTaskStatus(Bridge, TaskId), FString(TEXT("completed")));
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
    FUnrealEditorWebUIBridgeListTasksAndApprovalsTest,
    "UnrealEditorWebUI.Bridge.ListTasksAndApprovalReset",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUnrealEditorWebUIBridgeListTasksAndApprovalsTest::RunTest(const FString& Parameters)
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
    }

    Bridge->TestOnlyGrantPrivilegedCommandApproval(TEXT("asset.renameBatch"), TEXT("write"));
    TestTrue(
        TEXT("Approval is granted"),
        Bridge->TestOnlyHasPrivilegedCommandApproval(TEXT("asset.renameBatch"), TEXT("write")));
    Bridge->ResetPrivilegedCommandApprovals();
    TestFalse(
        TEXT("Approval reset clears write approval"),
        Bridge->TestOnlyHasPrivilegedCommandApproval(TEXT("asset.renameBatch"), TEXT("write")));
    return true;
}

#endif
