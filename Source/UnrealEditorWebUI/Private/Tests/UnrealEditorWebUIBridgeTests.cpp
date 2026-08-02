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
        {TEXT("timeout whitespace"), MakePreflightJson(TEXT("editor_tick"), TEXT("cooperative"), TEXT("seconds: 10"))},
        {TEXT("incomplete timeout exponent"), MakePreflightJson(TEXT("editor_tick"), TEXT("cooperative"), TEXT("seconds:1e"))},
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

    const FString LongPayloadValue = FString::ChrN(1300, TEXT('x'));
    const FString LongPreflight = FString::Printf(
        TEXT("{\"id\":\"req-test\",\"ok\":true,\"result\":{")
        TEXT("\"command\":\"editor.log\",\"permission\":\"write\",")
        TEXT("\"normalizedPayload\":{\"message\":\"%s\"},")
        TEXT("\"execution\":{\"thread\":\"editor_game_thread\",\"cancellationMode\":\"queued_only\",\"timeoutPolicy\":\"none\"}}}"),
        *LongPayloadValue);
    const TSharedPtr<FJsonObject> BoundedPreflight = ParseResultObject(
        Bridge->TestOnlyValidatePreflightResponse(TEXT("req-test"), LongPreflight));
    const FString BoundedPayloadSummary = BoundedPreflight.IsValid()
        ? BoundedPreflight->GetStringField(TEXT("payloadSummary"))
        : FString();
    TestEqual(TEXT("The native approval payload summary stays within 1,200 characters"), BoundedPayloadSummary.Len(), 1200);
    TestTrue(TEXT("A truncated native approval payload summary is explicit"), BoundedPayloadSummary.EndsWith(TEXT("...")));

    int32 ConfirmationCalls = 0;
    TArray<FString> ConfirmedCommands;
    TArray<FString> ConfirmedPermissions;
    TArray<FString> ConfirmedPayloads;
    Bridge->TestOnlySetPrivilegedCommandConfirmation(
        [&ConfirmationCalls, &ConfirmedCommands, &ConfirmedPermissions, &ConfirmedPayloads](
            const FString& CommandName,
            const FString& Permission,
            const FString& PayloadSummary)
        {
            ++ConfirmationCalls;
            ConfirmedCommands.Add(CommandName);
            ConfirmedPermissions.Add(Permission);
            ConfirmedPayloads.Add(PayloadSummary);
            return ConfirmationCalls == 1;
        });

    const FString DryRunResponse = Bridge->ExecuteCommand(
        TEXT("{\"id\":\"dry-approval\",\"command\":\"editor.log\",\"payload\":{\"message\":\"preview\",\"dryRun\":true}}"));
    const FString RealWriteResponse = Bridge->ExecuteCommand(
        TEXT("{\"id\":\"real-approval\",\"command\":\"editor.log\",\"payload\":{\"message\":\"apply\",\"dryRun\":false}}"));
    const TSharedPtr<FJsonObject> DryRunEnvelope = ParseJsonObject(DryRunResponse);
    bool bDryRunOk = false;
    TestTrue(
        TEXT("An approved dry run executes"),
        DryRunEnvelope.IsValid()
            && DryRunEnvelope->TryGetBoolField(TEXT("ok"), bDryRunOk)
            && bDryRunOk);
    TestEqual(
        TEXT("Dry-run approval does not authorize the later real write"),
        GetResponseErrorCode(RealWriteResponse),
        FString(TEXT("permission_denied")));
    TestEqual(TEXT("Both privileged invocations request their own approval"), ConfirmationCalls, 2);
    if (ConfirmedCommands.Num() == 2 && ConfirmedPermissions.Num() == 2 && ConfirmedPayloads.Num() == 2)
    {
        TestEqual(TEXT("The prompt receives the concrete command"), ConfirmedCommands[0], FString(TEXT("editor.log")));
        TestEqual(TEXT("The prompt receives the concrete permission"), ConfirmedPermissions[0], FString(TEXT("write")));
        TestTrue(TEXT("The dry-run prompt includes its normalized payload"), ConfirmedPayloads[0].Contains(TEXT("\"dryRun\":true")));
        TestTrue(TEXT("The real-write prompt includes its normalized payload"), ConfirmedPayloads[1].Contains(TEXT("\"dryRun\":false")));
        TestTrue(TEXT("Approvals are payload-specific"), ConfirmedPayloads[0] != ConfirmedPayloads[1]);

        const FString PromptMessage = Bridge->TestOnlyBuildPrivilegedCommandMessage(
            ConfirmedCommands[1],
            ConfirmedPermissions[1],
            ConfirmedPayloads[1]);
        TestTrue(TEXT("The native prompt names the command"), PromptMessage.Contains(TEXT("editor.log")));
        TestTrue(TEXT("The native prompt names the permission"), PromptMessage.Contains(TEXT("write")));
        TestTrue(TEXT("The native prompt includes the bounded payload summary"), PromptMessage.Contains(ConfirmedPayloads[1]));
        TestTrue(TEXT("The native prompt states that approval is single-use"), PromptMessage.Contains(TEXT("only to this invocation")));
    }
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

    const TSharedPtr<FJsonObject> StartedTask = ParseResultObject(
        Bridge->StartCommand(MakeRequestJson(TEXT("demo.longRun"), 3)));
    TestTrue(TEXT("A real cooperative Python handler starts through the native bridge"), StartedTask.IsValid());
    if (!StartedTask.IsValid())
    {
        return false;
    }

    const FString RealTaskId = StartedTask->GetStringField(TEXT("taskId"));
    TestEqual(TEXT("The real cooperative task enters running state"), GetTaskStatus(Bridge, RealTaskId), FString(TEXT("running")));
    Bridge->TestOnlyTickCooperativeTasks(0.25f);
    const TSharedPtr<FJsonObject> FirstStepTask = ParseResultObject(Bridge->GetTask(RealTaskId));
    TestTrue(TEXT("The first real handler step remains visible"), FirstStepTask.IsValid());
    if (FirstStepTask.IsValid())
    {
        TestEqual(TEXT("The first real handler step reports 33 percent"), FirstStepTask->GetIntegerField(TEXT("progress")), 33);
        const TArray<TSharedPtr<FJsonValue>>* Logs = nullptr;
        TestTrue(TEXT("The first real handler step exposes task logs"), FirstStepTask->TryGetArrayField(TEXT("logs"), Logs));
        bool bFoundRealHandlerLog = false;
        if (Logs != nullptr)
        {
            for (const TSharedPtr<FJsonValue>& Log : *Logs)
            {
                bFoundRealHandlerLog |= Log.IsValid() && Log->AsString().Contains(TEXT("Cooperative demo step 1/3."));
            }
        }
        TestTrue(TEXT("Task progress comes from the real Python handler log"), bFoundRealHandlerLog);
    }
    Bridge->TestOnlyTickCooperativeTasks(0.25f);
    const TSharedPtr<FJsonObject> SecondStepTask = ParseResultObject(Bridge->GetTask(RealTaskId));
    TestEqual(
        TEXT("The second real handler step reports 67 percent"),
        SecondStepTask.IsValid() ? SecondStepTask->GetIntegerField(TEXT("progress")) : -1,
        67);
    Bridge->TestOnlyTickCooperativeTasks(0.25f);
    TestEqual(TEXT("The real handler result completes the native task"), GetTaskStatus(Bridge, RealTaskId), FString(TEXT("completed")));

    const TSharedPtr<FJsonObject> CompletedTask = ParseResultObject(Bridge->GetTask(RealTaskId));
    FString CompletedResponseJson;
    TestTrue(
        TEXT("The completed native task retains the real handler response"),
        CompletedTask.IsValid() && CompletedTask->TryGetStringField(TEXT("responseJson"), CompletedResponseJson));
    const TSharedPtr<FJsonObject> CompletedResponse = ParseResultObject(CompletedResponseJson);
    TestTrue(TEXT("The real cooperative response contains a result"), CompletedResponse.IsValid());
    if (CompletedResponse.IsValid())
    {
        TestEqual(TEXT("The real cooperative response preserves the requested step count"), CompletedResponse->GetIntegerField(TEXT("steps")), 3);
        TestEqual(TEXT("The real cooperative response identifies its execution mode"), CompletedResponse->GetStringField(TEXT("mode")), FString(TEXT("cooperative")));
    }

    const TSharedPtr<FJsonObject> CancellableTask = ParseResultObject(
        Bridge->StartCommand(MakeRequestJson(TEXT("demo.longRun"), 100)));
    TestTrue(TEXT("A cancellable real cooperative task starts"), CancellableTask.IsValid());
    if (!CancellableTask.IsValid())
    {
        return false;
    }

    const FString CancellableTaskId = CancellableTask->GetStringField(TEXT("taskId"));
    Bridge->TestOnlyTickCooperativeTasks(0.25f);
    const TSharedPtr<FJsonObject> Cancellation = ParseResultObject(Bridge->CancelTask(CancellableTaskId));
    TestTrue(TEXT("Cancellation is accepted for the real cooperative task"), Cancellation.IsValid());
    Bridge->TestOnlyTickCooperativeTasks(0.25f);
    TestEqual(
        TEXT("Python cleanup and the native lifecycle agree on cancellation"),
        GetTaskStatus(Bridge, CancellableTaskId),
        FString(TEXT("cancelled")));

    const TSharedPtr<FJsonObject> TimeoutTask = ParseResultObject(
        Bridge->StartCommand(MakeRequestJson(TEXT("demo.longRun"), 100)));
    TestTrue(TEXT("A real cooperative task starts for timeout validation"), TimeoutTask.IsValid());
    if (!TimeoutTask.IsValid())
    {
        return false;
    }

    const FString TimeoutTaskId = TimeoutTask->GetStringField(TEXT("taskId"));
    TestTrue(
        TEXT("The timeout test can move the task clock without waiting ten seconds"),
        Bridge->TestOnlySetTaskCreatedAt(TimeoutTaskId, FDateTime::UtcNow() - FTimespan::FromSeconds(11)));
    Bridge->TestOnlyTickCooperativeTasks(0.25f);
    TestEqual(TEXT("A real cooperative Python job follows the native timeout lifecycle"), GetTaskStatus(Bridge, TimeoutTaskId), FString(TEXT("timed_out")));
    const TSharedPtr<FJsonObject> TimedOutTask = ParseResultObject(Bridge->GetTask(TimeoutTaskId));
    FString TimeoutResponseJson;
    TestTrue(
        TEXT("The timed-out task retains its structured response"),
        TimedOutTask.IsValid() && TimedOutTask->TryGetStringField(TEXT("responseJson"), TimeoutResponseJson));
    TestEqual(TEXT("The timeout response uses the stable error code"), GetResponseErrorCode(TimeoutResponseJson), FString(TEXT("task_timed_out")));

    const FString FailedRequest = TEXT("{\"id\":\"failed-task\",\"command\":\"missing.command\",\"payload\":{}}");
    const FString FailedTaskId = Bridge->TestOnlyCreateTask(
        FailedRequest,
        TEXT("queued"),
        TEXT("editor_game_thread"),
        TEXT("queued_only"),
        TEXT("none"),
        FDateTime::UtcNow());
    Bridge->TestOnlyRunTask(FailedTaskId, FailedRequest);
    TestEqual(TEXT("A failed Python envelope makes the native task truthful"), GetTaskStatus(Bridge, FailedTaskId), FString(TEXT("failed")));
    const TSharedPtr<FJsonObject> FailedTask = ParseResultObject(Bridge->GetTask(FailedTaskId));
    FString FailedResponseJson;
    TestTrue(
        TEXT("The failed native task retains the registry error envelope"),
        FailedTask.IsValid() && FailedTask->TryGetStringField(TEXT("responseJson"), FailedResponseJson));
    TestEqual(TEXT("The registry failure code survives task wrapping"), GetResponseErrorCode(FailedResponseJson), FString(TEXT("unknown_command")));
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
    constexpr int32 RequestLimit = 256 * 1024;
    const FString RequestPrefix = TEXT("{\"id\":\"boundary\",\"command\":\"system.ping\",\"payload\":{\"padding\":\"");
    const FString RequestSuffix = TEXT("\"}}");
    const FString ExactRequest = RequestPrefix
        + FString::ChrN(RequestLimit - RequestPrefix.Len() - RequestSuffix.Len(), TEXT('x'))
        + RequestSuffix;
    TestEqual(TEXT("The native request boundary fixture is exact"), ExactRequest.Len(), RequestLimit);
    const TSharedPtr<FJsonObject> ExactRequestResponse = ParseJsonObject(Bridge->ExecuteCommand(ExactRequest));
    bool bExactRequestOk = false;
    TestTrue(
        TEXT("A request exactly at 256 Ki characters reaches the registry"),
        ExactRequestResponse.IsValid()
            && ExactRequestResponse->TryGetBoolField(TEXT("ok"), bExactRequestOk)
            && bExactRequestOk);

    const FString OversizedRequest = RequestPrefix
        + FString::ChrN(RequestLimit - RequestPrefix.Len() - RequestSuffix.Len() + 1, TEXT('x'))
        + RequestSuffix;
    TestEqual(
        TEXT("A request one character over the limit fails before Python execution"),
        GetResponseErrorCode(Bridge->ExecuteCommand(OversizedRequest)),
        FString(TEXT("request_too_large")));
    TestEqual(
        TEXT("An asynchronous request one character over the limit fails before queuing"),
        GetResponseErrorCode(Bridge->StartCommand(OversizedRequest)),
        FString(TEXT("request_too_large")));

    constexpr int32 SettingsLimit = 64 * 1024;
    const FString ExactInvalidSettings = FString::ChrN(SettingsLimit, TEXT('x'));
    TestEqual(
        TEXT("Settings exactly at 64 Ki characters pass the size gate"),
        GetResponseErrorCode(Bridge->SetWebUISettings(ExactInvalidSettings)),
        FString(TEXT("invalid_settings")));
    TestEqual(
        TEXT("Settings one character over the limit fail before parsing"),
        GetResponseErrorCode(Bridge->SetWebUISettings(ExactInvalidSettings + TEXT("x"))),
        FString(TEXT("request_too_large")));

    TestEqual(
        TEXT("A 128-character task id passes validation before lookup"),
        GetResponseErrorCode(Bridge->GetTask(FString::ChrN(128, TEXT('a')))),
        FString(TEXT("task_not_found")));
    TestEqual(
        TEXT("A 129-character task id fails validation"),
        GetResponseErrorCode(Bridge->GetTask(FString::ChrN(129, TEXT('a')))),
        FString(TEXT("invalid_task_id")));

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

    const FString ExactResponseTaskId = Bridge->TestOnlyCreateTask(
        MakeRequestJson(TEXT("system.ping"), 1),
        TEXT("running"),
        TEXT("editor_game_thread"),
        TEXT("queued_only"),
        TEXT("none"),
        FDateTime::UtcNow(),
        10);
    const FString ExactTaskResponse = FString::ChrN(1536 * 1024, TEXT('x'));
    Bridge->TestOnlyCompleteTaskWithResponse(ExactResponseTaskId, ExactTaskResponse);
    const TSharedPtr<FJsonObject> ExactResponseTask = ParseResultObject(Bridge->GetTask(ExactResponseTaskId));
    TestEqual(
        TEXT("A task response exactly at 1.5 MiB remains completed"),
        ExactResponseTask.IsValid() ? ExactResponseTask->GetStringField(TEXT("status")) : FString(),
        FString(TEXT("completed")));
    TestEqual(
        TEXT("The exact-limit task response remains intact"),
        ExactResponseTask.IsValid() ? ExactResponseTask->GetStringField(TEXT("responseJson")).Len() : -1,
        ExactTaskResponse.Len());

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
        FString::ChrN((1536 * 1024) + 1, TEXT('x')));
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

    FString LastEventJson;
    Bridge->SetEventDispatcher([&LastEventJson](const FString& EventJson)
    {
        LastEventJson = EventJson;
    });

    const FString ExactLogLine = FString::ChrN(2048, TEXT('a'));
    const FString ExactLogTaskId = Bridge->TestOnlyCreateTask(
        MakeRequestJson(TEXT("system.ping"), 1),
        TEXT("running"),
        TEXT("editor_game_thread"),
        TEXT("queued_only"),
        TEXT("none"),
        FDateTime::UtcNow());
    Bridge->TestOnlyCompleteTaskWithResponse(ExactLogTaskId, TEXT("{\"ok\":true}"), ExactLogLine);

    const TSharedPtr<FJsonObject> ExactLogTask = ParseResultObject(Bridge->GetTask(ExactLogTaskId));
    const TArray<TSharedPtr<FJsonValue>>* ExactLogs = nullptr;
    TestTrue(
        TEXT("A task log exactly at the documented limit is retained"),
        ExactLogTask.IsValid() && ExactLogTask->TryGetArrayField(TEXT("logs"), ExactLogs));
    if (ExactLogs != nullptr && ExactLogs->Num() == 1)
    {
        TestEqual(TEXT("The exact-limit task log is unchanged"), (*ExactLogs)[0]->AsString(), ExactLogLine);
    }
    const TSharedPtr<FJsonObject> ExactEvent = ParseJsonObject(LastEventJson);
    TestEqual(
        TEXT("The exact-limit task event log is unchanged"),
        ExactEvent.IsValid() ? ExactEvent->GetStringField(TEXT("log")) : FString(),
        ExactLogLine);

    const FString OversizedLogLine = FString::ChrN(2049, TEXT('b'));
    const FString OversizedLogTaskId = Bridge->TestOnlyCreateTask(
        MakeRequestJson(TEXT("system.ping"), 1),
        TEXT("running"),
        TEXT("editor_game_thread"),
        TEXT("queued_only"),
        TEXT("none"),
        FDateTime::UtcNow());
    Bridge->TestOnlyCompleteTaskWithResponse(OversizedLogTaskId, TEXT("{\"ok\":true}"), OversizedLogLine);

    const TSharedPtr<FJsonObject> OversizedLogTask = ParseResultObject(Bridge->GetTask(OversizedLogTaskId));
    const TArray<TSharedPtr<FJsonValue>>* OversizedLogs = nullptr;
    TestTrue(
        TEXT("An over-limit task log remains available in bounded form"),
        OversizedLogTask.IsValid() && OversizedLogTask->TryGetArrayField(TEXT("logs"), OversizedLogs));
    if (OversizedLogs != nullptr && OversizedLogs->Num() == 1)
    {
        const FString StoredLogLine = (*OversizedLogs)[0]->AsString();
        TestEqual(TEXT("Stored task logs never exceed 2,048 characters"), StoredLogLine.Len(), 2048);
        TestTrue(TEXT("Stored over-limit task logs carry a truncation marker"), StoredLogLine.EndsWith(TEXT("...")));
    }
    const TSharedPtr<FJsonObject> OversizedEvent = ParseJsonObject(LastEventJson);
    const FString EventLogLine = OversizedEvent.IsValid()
        ? OversizedEvent->GetStringField(TEXT("log"))
        : FString();
    TestEqual(TEXT("Task event logs never exceed 2,048 characters"), EventLogLine.Len(), 2048);
    TestTrue(TEXT("Over-limit task event logs carry a truncation marker"), EventLogLine.EndsWith(TEXT("...")));

    const FString LogRetentionTaskId = Bridge->TestOnlyCreateTask(
        MakeRequestJson(TEXT("system.ping"), 1),
        TEXT("running"),
        TEXT("editor_game_thread"),
        TEXT("queued_only"),
        TEXT("none"),
        FDateTime::UtcNow());
    for (int32 LogIndex = 0; LogIndex <= 80; ++LogIndex)
    {
        Bridge->TestOnlyCompleteTaskWithResponse(
            LogRetentionTaskId,
            TEXT("{\"ok\":true}"),
            FString::Printf(TEXT("line-%d"), LogIndex));
    }
    const TSharedPtr<FJsonObject> LogRetentionTask = ParseResultObject(Bridge->GetTask(LogRetentionTaskId));
    const TArray<TSharedPtr<FJsonValue>>* RetainedLogs = nullptr;
    TestTrue(
        TEXT("The task with repeated updates exposes retained logs"),
        LogRetentionTask.IsValid() && LogRetentionTask->TryGetArrayField(TEXT("logs"), RetainedLogs));
    TestEqual(TEXT("A task retains at most 80 log lines"), RetainedLogs == nullptr ? -1 : RetainedLogs->Num(), 80);
    if (RetainedLogs != nullptr && RetainedLogs->Num() == 80)
    {
        TestEqual(TEXT("The oldest over-budget log line is evicted"), (*RetainedLogs)[0]->AsString(), FString(TEXT("line-1")));
        TestEqual(TEXT("The newest log line remains available"), (*RetainedLogs)[79]->AsString(), FString(TEXT("line-80")));
    }
    return true;
}

#endif
