#if WITH_DEV_AUTOMATION_TESTS

#include "UnrealEditorWebUIBridge.h"

#include "Containers/StringConv.h"
#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/AutomationTest.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"
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

    FString GetResponseErrorMessage(const FString& ResponseJson)
    {
        const TSharedPtr<FJsonObject> Response = ParseJsonObject(ResponseJson);
        if (!Response.IsValid())
        {
            return FString();
        }

        const TSharedPtr<FJsonObject>* Error = nullptr;
        if (Response->TryGetObjectField(TEXT("error"), Error) && Error != nullptr && Error->IsValid())
        {
            FString Message;
            (*Error)->TryGetStringField(TEXT("message"), Message);
            return Message;
        }

        return FString();
    }

    FString GetCatalogDiagnosticCode(const TSharedPtr<FJsonObject>& Result)
    {
        if (!Result.IsValid())
        {
            return FString();
        }
        FString DiagnosticCode;
        Result->TryGetStringField(TEXT("diagnosticCode"), DiagnosticCode);
        return DiagnosticCode;
    }

    bool IsNullJsonField(const TSharedPtr<FJsonObject>& Object, const FString& FieldName)
    {
        if (!Object.IsValid())
        {
            return false;
        }
        const TSharedPtr<FJsonValue> Value = Object->TryGetField(FieldName);
        return Value.IsValid() && Value->Type == EJson::Null;
    }

    bool HasExactToolCatalogResultKeys(const TSharedPtr<FJsonObject>& Result)
    {
        return Result.IsValid()
            && Result->Values.Num() == 4
            && Result->HasField(TEXT("protocolVersion"))
            && Result->HasField(TEXT("source"))
            && Result->HasField(TEXT("catalog"))
            && Result->HasField(TEXT("diagnosticCode"));
    }

    bool HasExactWebUIHealthResultKeys(const TSharedPtr<FJsonObject>& Result)
    {
        return Result.IsValid()
            && Result->Values.Num() == 8
            && Result->HasField(TEXT("protocolVersion"))
            && Result->HasField(TEXT("bridgeProtocolVersion"))
            && Result->HasField(TEXT("pluginVersion"))
            && Result->HasField(TEXT("engineVersion"))
            && Result->HasField(TEXT("documentScope"))
            && Result->HasField(TEXT("pythonRuntime"))
            && Result->HasField(TEXT("privilegedConfirmation"))
            && Result->HasField(TEXT("taskSessionIsolation"));
    }

    bool IsCanonicalPluginVersion(const FString& PluginVersion)
    {
        if (PluginVersion.IsEmpty() || PluginVersion.Len() > 64)
        {
            return false;
        }

        bool bRequiresAlphanumeric = true;
        for (const TCHAR Character : PluginVersion)
        {
            const bool bIsAsciiDigit = Character >= TEXT('0') && Character <= TEXT('9');
            const bool bIsAsciiUpper = Character >= TEXT('A') && Character <= TEXT('Z');
            const bool bIsAsciiLower = Character >= TEXT('a') && Character <= TEXT('z');
            if (bIsAsciiDigit || bIsAsciiUpper || bIsAsciiLower)
            {
                bRequiresAlphanumeric = false;
            }
            else if ((Character == TEXT('.') || Character == TEXT('-'))
                && !bRequiresAlphanumeric)
            {
                bRequiresAlphanumeric = true;
            }
            else
            {
                return false;
            }
        }
        return !bRequiresAlphanumeric;
    }

    FString MakeFileURL(const FString& Path)
    {
        const FString NormalizedPath = Path.Replace(TEXT("\\"), TEXT("/"));
#if PLATFORM_WINDOWS
        return FString::Printf(TEXT("file:///%s"), *NormalizedPath);
#else
        return FString::Printf(TEXT("file://%s"), *NormalizedPath);
#endif
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
    FUnrealEditorWebUIProjectToolCatalogTest,
    "UnrealEditorWebUI.Bridge.ProjectToolCatalog",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUnrealEditorWebUIProjectToolCatalogTest::RunTest(const FString& Parameters)
{
    static_cast<void>(Parameters);

    UUnrealEditorWebUIBridge* Bridge = NewObject<UUnrealEditorWebUIBridge>();
    const FString ExpectedHostMarker = FPlatformMisc::GetEnvironmentVariable(TEXT("UE_WEBUI_CATALOG_MARKER"));
    if (!ExpectedHostMarker.IsEmpty())
    {
        const FString HostResponseJson = Bridge->GetToolCatalog();
        const TSharedPtr<FJsonObject> HostResult = ParseResultObject(HostResponseJson);
        TestTrue(TEXT("The CI host project catalog is available through the production getter"), HostResult.IsValid());
        if (HostResult.IsValid())
        {
            TestTrue(TEXT("The CI host catalog result has only the documented fields"), HasExactToolCatalogResultKeys(HostResult));
            TestEqual(TEXT("The CI host catalog uses protocol version 1"), HostResult->GetIntegerField(TEXT("protocolVersion")), 1);
            TestEqual(
                TEXT("The CI host project reports a project catalog source"),
                HostResult->GetStringField(TEXT("source")),
                FString(TEXT("project")));
            TestTrue(TEXT("The CI host project catalog has no transport diagnostic"), IsNullJsonField(HostResult, TEXT("diagnosticCode")));
            const TSharedPtr<FJsonObject>* HostCatalog = nullptr;
            TestTrue(TEXT("The CI host catalog is embedded as an object"), HostResult->TryGetObjectField(TEXT("catalog"), HostCatalog));
            if (HostCatalog != nullptr && HostCatalog->IsValid())
            {
                const TArray<TSharedPtr<FJsonValue>>* Projects = nullptr;
                TestTrue(TEXT("The CI host catalog contains projects"), (*HostCatalog)->TryGetArrayField(TEXT("projects"), Projects));
                TestEqual(TEXT("The CI host catalog contains exactly one project"), Projects != nullptr ? Projects->Num() : -1, 1);
                if (Projects != nullptr && Projects->Num() == 1)
                {
                    const TSharedPtr<FJsonObject> Project = (*Projects)[0]->AsObject();
                    TestTrue(TEXT("The CI host project entry is an object"), Project.IsValid());
                    if (Project.IsValid())
                    {
                        TestEqual(
                            TEXT("The production getter preserves the exact fresh project id"),
                            Project->GetStringField(TEXT("id")),
                            FString::Printf(TEXT("project-%s"), *ExpectedHostMarker));
                    }
                }
            }
        }
    }
    else
    {
        AddInfo(TEXT("UE_WEBUI_CATALOG_MARKER is unset; running isolated loader coverage without the CI host assertion."));
    }

    const FString TestRoot = FPaths::Combine(
        FPaths::ProjectSavedDir(),
        TEXT("Automation"),
        FString::Printf(TEXT("ToolCatalog-%s"), *FGuid::NewGuid().ToString(EGuidFormats::Digits)));
    const FString ConfigDir = FPaths::Combine(TestRoot, TEXT("Config"));
    const FString CatalogDir = FPaths::Combine(ConfigDir, TEXT("UnrealEditorWebUI"));
    const FString CatalogPath = FPaths::Combine(CatalogDir, TEXT("ToolCatalog.json"));
    IFileManager& FileManager = IFileManager::Get();
    FString FullAutomationRoot = FPaths::ConvertRelativePathToFull(FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("Automation")));
    FString FullTestRoot = FPaths::ConvertRelativePathToFull(TestRoot);
    FPaths::NormalizeDirectoryName(FullAutomationRoot);
    FPaths::NormalizeDirectoryName(FullTestRoot);
    const bool bSafeTestRoot = FullTestRoot.StartsWith(FullAutomationRoot + TEXT("/"))
        && FPaths::GetCleanFilename(FullTestRoot).StartsWith(TEXT("ToolCatalog-"));
    const bool bFreshTestRoot = !FileManager.DirectoryExists(*FullTestRoot);
    TestTrue(TEXT("The isolated catalog root stays under the project Automation directory"), bSafeTestRoot);
    TestTrue(TEXT("The GUID-scoped catalog root starts fresh"), bFreshTestRoot);
    if (!bSafeTestRoot || !bFreshTestRoot)
    {
        return false;
    }

    const TSharedPtr<FJsonObject> MissingResult = ParseResultObject(
        Bridge->TestOnlyGetToolCatalogFromProjectConfigDir(ConfigDir));
    TestTrue(TEXT("A missing project catalog returns a result"), MissingResult.IsValid());
    if (MissingResult.IsValid())
    {
        TestTrue(TEXT("A missing catalog result has only the documented fields"), HasExactToolCatalogResultKeys(MissingResult));
        TestEqual(TEXT("A missing catalog result uses protocol version 1"), MissingResult->GetIntegerField(TEXT("protocolVersion")), 1);
        TestEqual(TEXT("A missing project catalog selects the missing state"), MissingResult->GetStringField(TEXT("source")), FString(TEXT("missing")));
        TestTrue(TEXT("A missing project catalog has a null catalog"), IsNullJsonField(MissingResult, TEXT("catalog")));
        TestTrue(TEXT("A missing project catalog has no native diagnostic"), IsNullJsonField(MissingResult, TEXT("diagnosticCode")));
    }

    TestTrue(TEXT("The isolated catalog directory is created"), FileManager.MakeDirectory(*CatalogDir, true));
    const FString ValidCatalog =
        TEXT("{\"schemaVersion\":1,")
        TEXT("\"projects\":[{\"id\":\"unit-project\",\"name\":\"Unit Project\",\"description\":\"Native loader fixture\",\"stages\":[\"unit-stage\"]}],")
        TEXT("\"stages\":[{\"id\":\"unit-stage\",\"label\":\"Unit Stage\"}],")
        TEXT("\"categories\":[{\"id\":\"all\",\"label\":\"All\",\"icon\":\"grid\"},{\"id\":\"favorites\",\"label\":\"Favorites\",\"icon\":\"star\"},{\"id\":\"recent\",\"label\":\"Recent\",\"icon\":\"recent\"}],")
        TEXT("\"defaultPreferences\":{\"projectId\":\"unit-project\",\"stageId\":\"unit-stage\",\"categoryId\":\"all\",\"favorites\":[],\"openTabs\":[]}}");
    TestTrue(
        TEXT("A valid catalog fixture is written"),
        FFileHelper::SaveStringToFile(
            ValidCatalog,
            *CatalogPath,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    const TSharedPtr<FJsonObject> ValidResult = ParseResultObject(
        Bridge->TestOnlyGetToolCatalogFromProjectConfigDir(ConfigDir));
    TestTrue(TEXT("A valid project catalog returns a result"), ValidResult.IsValid());
    if (ValidResult.IsValid())
    {
        TestTrue(TEXT("A valid catalog result has only the documented fields"), HasExactToolCatalogResultKeys(ValidResult));
        TestEqual(TEXT("A valid project catalog selects the project source"), ValidResult->GetStringField(TEXT("source")), FString(TEXT("project")));
        TestTrue(TEXT("A valid project catalog has no transport diagnostic"), IsNullJsonField(ValidResult, TEXT("diagnosticCode")));
        const TSharedPtr<FJsonObject>* Catalog = nullptr;
        TestTrue(TEXT("A valid project catalog is embedded as an object"), ValidResult->TryGetObjectField(TEXT("catalog"), Catalog));
        if (Catalog != nullptr && Catalog->IsValid())
        {
            TestEqual(TEXT("The native loader preserves schema version 1"), (*Catalog)->GetIntegerField(TEXT("schemaVersion")), 1);
        }
    }

    const TArray<TPair<FString, FString>> InvalidSchemaVersions = {
        {TEXT("{}"), TEXT("catalog_invalid_schema_version")},
        {TEXT("{\"schemaVersion\":\"1\"}"), TEXT("catalog_invalid_schema_version")},
        {TEXT("{\"schemaVersion\":true}"), TEXT("catalog_invalid_schema_version")},
        {TEXT("{\"schemaVersion\":1.5}"), TEXT("catalog_invalid_schema_version")},
        {TEXT("{\"schemaVersion\":0}"), TEXT("catalog_unsupported_version")},
        {TEXT("{\"schemaVersion\":2}"), TEXT("catalog_unsupported_version")},
    };
    for (int32 Index = 0; Index < InvalidSchemaVersions.Num(); ++Index)
    {
        TestTrue(
            *FString::Printf(TEXT("Invalid schema-version fixture %d is written"), Index),
            FFileHelper::SaveStringToFile(
                InvalidSchemaVersions[Index].Key,
                *CatalogPath,
                FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
        const TSharedPtr<FJsonObject> InvalidVersionResult = ParseResultObject(
            Bridge->TestOnlyGetToolCatalogFromProjectConfigDir(ConfigDir));
        TestEqual(
            *FString::Printf(TEXT("Invalid schema-version fixture %d fails deterministically"), Index),
            GetCatalogDiagnosticCode(InvalidVersionResult),
            InvalidSchemaVersions[Index].Value);
        TestTrue(
            *FString::Printf(TEXT("Invalid schema-version fixture %d does not return a catalog"), Index),
            IsNullJsonField(InvalidVersionResult, TEXT("catalog")));
    }

    TestTrue(
        TEXT("An invalid-root catalog fixture is written"),
        FFileHelper::SaveStringToFile(
            TEXT("[]"),
            *CatalogPath,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    const TSharedPtr<FJsonObject> InvalidJsonResult = ParseResultObject(
        Bridge->TestOnlyGetToolCatalogFromProjectConfigDir(ConfigDir));
    TestEqual(
        TEXT("A non-object catalog is rejected as invalid JSON input"),
        GetCatalogDiagnosticCode(InvalidJsonResult),
        FString(TEXT("catalog_invalid_json")));

    const FString UnicodeCatalog = ValidCatalog.Replace(
        TEXT("Native loader fixture"),
        TEXT("\u76EE\u5F55 fixture"));
    const FTCHARToUTF8 UnicodeUtf8(*UnicodeCatalog);
    TArray<uint8> BomUnicodeBytes = {0xEF, 0xBB, 0xBF};
    BomUnicodeBytes.Append(
        reinterpret_cast<const uint8*>(UnicodeUtf8.Get()),
        UnicodeUtf8.Length());
    TestTrue(TEXT("A UTF-8 BOM and multibyte fixture is written"), FFileHelper::SaveArrayToFile(BomUnicodeBytes, *CatalogPath));
    const TSharedPtr<FJsonObject> BomUnicodeResult = ParseResultObject(
        Bridge->TestOnlyGetToolCatalogFromProjectConfigDir(ConfigDir));
    TestEqual(
        TEXT("A UTF-8 BOM and valid multibyte text pass the encoding gate"),
        BomUnicodeResult.IsValid() ? BomUnicodeResult->GetStringField(TEXT("source")) : FString(),
        FString(TEXT("project")));

    auto AppendAsciiBytes = [](TArray<uint8>& Bytes, const ANSICHAR* Text)
    {
        while (*Text != '\0')
        {
            Bytes.Add(static_cast<uint8>(*Text));
            ++Text;
        }
    };
    TArray<uint8> FourByteUtf8;
    AppendAsciiBytes(FourByteUtf8, "{\"schemaVersion\":1,\"emoji\":\"");
    FourByteUtf8.Add(0xF0);
    FourByteUtf8.Add(0x9F);
    FourByteUtf8.Add(0x98);
    FourByteUtf8.Add(0x80);
    AppendAsciiBytes(FourByteUtf8, "\"}");
    TestTrue(TEXT("A four-byte UTF-8 fixture is written"), FFileHelper::SaveArrayToFile(FourByteUtf8, *CatalogPath));
    const TSharedPtr<FJsonObject> FourByteUtf8Result = ParseResultObject(
        Bridge->TestOnlyGetToolCatalogFromProjectConfigDir(ConfigDir));
    TestEqual(
        TEXT("A valid four-byte UTF-8 sequence passes the encoding gate"),
        FourByteUtf8Result.IsValid() ? FourByteUtf8Result->GetStringField(TEXT("source")) : FString(),
        FString(TEXT("project")));

    struct FInvalidUtf8Case
    {
        FString Name;
        TArray<uint8> Bytes;
    };
    const TArray<FInvalidUtf8Case> InvalidUtf8Cases = {
        {TEXT("UTF-16 BOM"), {0xFF, 0xFE, 0x7B, 0x7D}},
        {TEXT("lone continuation"), {0x80}},
        {TEXT("two-byte overlong"), {0xC0, 0x80}},
        {TEXT("three-byte overlong"), {0xE0, 0x80, 0x80}},
        {TEXT("UTF-16 surrogate"), {0xED, 0xA0, 0x80}},
        {TEXT("out-of-range code point"), {0xF4, 0x90, 0x80, 0x80}},
        {TEXT("truncated sequence"), {0xE2, 0x82}},
        {TEXT("embedded NUL"), {0x7B, 0x00, 0x7D}},
    };
    for (const FInvalidUtf8Case& TestCase : InvalidUtf8Cases)
    {
        TestTrue(
            *FString::Printf(TEXT("The %s fixture is written"), *TestCase.Name),
            FFileHelper::SaveArrayToFile(TestCase.Bytes, *CatalogPath));
        const TSharedPtr<FJsonObject> InvalidEncodingResult = ParseResultObject(
            Bridge->TestOnlyGetToolCatalogFromProjectConfigDir(ConfigDir));
        TestEqual(
            *FString::Printf(TEXT("The %s fixture is rejected before JSON parsing"), *TestCase.Name),
            GetCatalogDiagnosticCode(InvalidEncodingResult),
            FString(TEXT("catalog_invalid_encoding")));
        TestTrue(
            *FString::Printf(TEXT("The %s fixture does not return a catalog"), *TestCase.Name),
            IsNullJsonField(InvalidEncodingResult, TEXT("catalog")));
    }

    const FString MaximumDepth =
        TEXT("{\"schemaVersion\":1,\"value\":")
        + FString::ChrN(15, TEXT('['))
        + TEXT("0")
        + FString::ChrN(15, TEXT(']'))
        + TEXT("}");
    TestTrue(
        TEXT("A maximum-depth fixture is written"),
        FFileHelper::SaveStringToFile(
            MaximumDepth,
            *CatalogPath,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    const TSharedPtr<FJsonObject> MaximumDepthResult = ParseResultObject(
        Bridge->TestOnlyGetToolCatalogFromProjectConfigDir(ConfigDir));
    TestEqual(
        TEXT("JSON at depth 16 passes the complexity gate"),
        MaximumDepthResult.IsValid() ? MaximumDepthResult->GetStringField(TEXT("source")) : FString(),
        FString(TEXT("project")));

    const FString ExcessiveDepth =
        TEXT("{\"schemaVersion\":1,\"value\":")
        + FString::ChrN(16, TEXT('['))
        + TEXT("0")
        + FString::ChrN(16, TEXT(']'))
        + TEXT("}");
    TestTrue(
        TEXT("An excessive-depth fixture is written"),
        FFileHelper::SaveStringToFile(
            ExcessiveDepth,
            *CatalogPath,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    const TSharedPtr<FJsonObject> ExcessiveDepthResult = ParseResultObject(
        Bridge->TestOnlyGetToolCatalogFromProjectConfigDir(ConfigDir));
    TestEqual(
        TEXT("Excessive JSON depth is rejected before DOM construction"),
        GetCatalogDiagnosticCode(ExcessiveDepthResult),
        FString(TEXT("catalog_resource_limit")));

    auto BuildNodeCatalog = [](int32 ValueCount)
    {
        FString Json = TEXT("{\"schemaVersion\":1,\"values\":[");
        Json.Reserve(Json.Len() + (ValueCount * 2) + 2);
        for (int32 Index = 0; Index < ValueCount; ++Index)
        {
            if (Index > 0)
            {
                Json.AppendChar(TEXT(','));
            }
            Json.AppendChar(TEXT('0'));
        }
        Json += TEXT("]}");
        return Json;
    };
    TestTrue(
        TEXT("A 10,000-node fixture is written"),
        FFileHelper::SaveStringToFile(
            BuildNodeCatalog(9997),
            *CatalogPath,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    const TSharedPtr<FJsonObject> MaximumNodesResult = ParseResultObject(
        Bridge->TestOnlyGetToolCatalogFromProjectConfigDir(ConfigDir));
    TestEqual(
        TEXT("JSON at 10,000 structural nodes passes the complexity gate"),
        MaximumNodesResult.IsValid() ? MaximumNodesResult->GetStringField(TEXT("source")) : FString(),
        FString(TEXT("project")));

    TestTrue(
        TEXT("A 10,001-node fixture is written"),
        FFileHelper::SaveStringToFile(
            BuildNodeCatalog(9998),
            *CatalogPath,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    const TSharedPtr<FJsonObject> ExcessiveNodesResult = ParseResultObject(
        Bridge->TestOnlyGetToolCatalogFromProjectConfigDir(ConfigDir));
    TestEqual(
        TEXT("JSON above 10,000 structural nodes is rejected before DOM construction"),
        GetCatalogDiagnosticCode(ExcessiveNodesResult),
        FString(TEXT("catalog_resource_limit")));

    const FString ExactSizePrefix = TEXT("{\"schemaVersion\":1,\"padding\":\"");
    const FString ExactSizeSuffix = TEXT("\"}");
    const int32 ExactPaddingCharacters = (128 * 1024) - ExactSizePrefix.Len() - ExactSizeSuffix.Len();
    const FString ExactSizeCatalog =
        ExactSizePrefix
        + FString::ChrN(ExactPaddingCharacters, TEXT(','))
        + ExactSizeSuffix;
    TestTrue(
        TEXT("An exact 128 KiB catalog fixture is written"),
        FFileHelper::SaveStringToFile(
            ExactSizeCatalog,
            *CatalogPath,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    const TSharedPtr<FJsonObject> ExactSizeResult = ParseResultObject(
        Bridge->TestOnlyGetToolCatalogFromProjectConfigDir(ConfigDir));
    TestEqual(
        TEXT("A catalog exactly at 128 KiB passes the byte and string-aware complexity gates"),
        ExactSizeResult.IsValid() ? ExactSizeResult->GetStringField(TEXT("source")) : FString(),
        FString(TEXT("project")));

    TestTrue(
        TEXT("An oversized catalog fixture is written"),
        FFileHelper::SaveStringToFile(
            ExactSizeCatalog.LeftChop(ExactSizeSuffix.Len()) + TEXT(",") + ExactSizeSuffix,
            *CatalogPath,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    const TSharedPtr<FJsonObject> OversizedResult = ParseResultObject(
        Bridge->TestOnlyGetToolCatalogFromProjectConfigDir(ConfigDir));
    TestEqual(
        TEXT("A catalog over 128 KiB is rejected before parsing"),
        GetCatalogDiagnosticCode(OversizedResult),
        FString(TEXT("catalog_too_large")));

    TestTrue(TEXT("The isolated catalog fixture directory is removed"), FileManager.DeleteDirectory(*FullTestRoot, false, true));
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
    FUnrealEditorWebUIBridgeHealthTest,
    "UnrealEditorWebUI.Bridge.WebUIHealth",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUnrealEditorWebUIBridgeHealthTest::RunTest(const FString& Parameters)
{
    static_cast<void>(Parameters);

    UUnrealEditorWebUIBridge* Bridge = NewObject<UUnrealEditorWebUIBridge>();
    const FString ProductionResponse = Bridge->GetWebUIHealth();
    const TSharedPtr<FJsonObject> ProductionEnvelope = ParseJsonObject(ProductionResponse);
    const TSharedPtr<FJsonObject> ProductionResult = ParseResultObject(ProductionResponse);
    TestTrue(TEXT("The production health response is a JSON object"), ProductionEnvelope.IsValid());
    TestTrue(TEXT("The production health response has a null request id"), IsNullJsonField(ProductionEnvelope, TEXT("id")));
    TestTrue(TEXT("The production health response has the exact result shape"), HasExactWebUIHealthResultKeys(ProductionResult));
    if (!ProductionResult.IsValid())
    {
        return false;
    }

    TestEqual(TEXT("Health protocol version is 1"), ProductionResult->GetIntegerField(TEXT("protocolVersion")), 1);
    TestEqual(TEXT("Bridge protocol version is 1"), ProductionResult->GetIntegerField(TEXT("bridgeProtocolVersion")), 1);
    const FString PluginVersion = ProductionResult->GetStringField(TEXT("pluginVersion"));
    TestTrue(TEXT("The descriptor version is bounded and canonical ASCII"), IsCanonicalPluginVersion(PluginVersion));

    const FEngineVersion& CurrentEngineVersion = FEngineVersion::Current();
    const FString ExpectedEngineVersion = FString::Printf(
        TEXT("%d.%d.%d"),
        static_cast<int32>(CurrentEngineVersion.GetMajor()),
        static_cast<int32>(CurrentEngineVersion.GetMinor()),
        static_cast<int32>(CurrentEngineVersion.GetPatch()));
    TestEqual(
        TEXT("The engine version contains only major.minor.patch"),
        ProductionResult->GetStringField(TEXT("engineVersion")),
        ExpectedEngineVersion);
    TestEqual(
        TEXT("A new bridge starts with an inactive document scope"),
        ProductionResult->GetStringField(TEXT("documentScope")),
        FString(TEXT("inactive")));
    const FString ProductionPythonRuntime = ProductionResult->GetStringField(TEXT("pythonRuntime"));
    TestTrue(
        TEXT("The Python probe returns only its documented enum"),
        ProductionPythonRuntime == TEXT("available") || ProductionPythonRuntime == TEXT("unavailable"));
    TestEqual(
        TEXT("Privileged confirmation is per call"),
        ProductionResult->GetStringField(TEXT("privilegedConfirmation")),
        FString(TEXT("per_call")));
    TestEqual(
        TEXT("Task sessions are isolated per document"),
        ProductionResult->GetStringField(TEXT("taskSessionIsolation")),
        FString(TEXT("document")));

    const auto TestScope = [this, Bridge](
        const FString& SecurityScope,
        const FString& ExpectedScope,
        const FString& Description)
    {
        Bridge->BeginDocumentSession(SecurityScope);
        const FString Response = Bridge->TestOnlyBuildWebUIHealthResponse(TEXT("0.1.1"), true);
        const TSharedPtr<FJsonObject> Result = ParseResultObject(Response);
        TestTrue(*FString::Printf(TEXT("%s returns a health result"), *Description), Result.IsValid());
        if (Result.IsValid())
        {
            TestEqual(
                *FString::Printf(TEXT("%s stores only the expected classification"), *Description),
                Result->GetStringField(TEXT("documentScope")),
                ExpectedScope);
            TestTrue(
                *FString::Printf(TEXT("%s keeps the exact health shape"), *Description),
                HasExactWebUIHealthResultKeys(Result));
        }
        return Response;
    };

    TestScope(TEXT("about:blank"), TEXT("inactive"), TEXT("about:blank"));
    TestScope(TEXT("module-shutdown"), TEXT("inactive"), TEXT("module shutdown"));
    TestScope(TEXT("tab-replaced"), TEXT("inactive"), TEXT("tab replacement"));
    TestScope(TEXT("https://example.com/private"), TEXT("inactive"), TEXT("a rejected remote URL"));
    TestScope(TEXT("http://localhost:5173/tools"), TEXT("loopback_http"), TEXT("an HTTP loopback URL"));
    TestScope(TEXT("https://127.0.0.1:443/tools"), TEXT("loopback_https"), TEXT("an HTTPS loopback URL"));

    const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("UnrealEditorWebUI"));
    if (TestTrue(TEXT("The plugin descriptor is available for packaged scope coverage"), Plugin.IsValid()))
    {
        const FString PackagedPath = FPaths::ConvertRelativePathToFull(
            FPaths::Combine(Plugin->GetBaseDir(), TEXT("Web/index.html")));
        const FString PackagedURL = MakeFileURL(PackagedPath);
        const FString PackagedResponse = TestScope(PackagedURL, TEXT("packaged"), TEXT("a packaged Web file URL"));
        TestFalse(TEXT("The packaged health response never returns the source path"), PackagedResponse.Contains(TEXT("index.html")));
    }

    const FString URLCanary = TEXT("health_redaction_canary_7f3d");
    const FString CanaryURL = FString::Printf(
        TEXT("http://localhost:5173/tools?supportSecret=%s"),
        *URLCanary);
    const FString CanaryResponse = TestScope(CanaryURL, TEXT("loopback_http"), TEXT("a URL containing a redaction canary"));
    TestFalse(TEXT("The health response never returns a raw URL canary"), CanaryResponse.Contains(URLCanary));
    TestFalse(TEXT("The health response never returns the raw loopback authority"), CanaryResponse.Contains(TEXT("localhost")));

    const TSharedPtr<FJsonObject> AvailablePythonResult = ParseResultObject(
        Bridge->TestOnlyBuildWebUIHealthResponse(TEXT("0.1.1"), true));
    const TSharedPtr<FJsonObject> UnavailablePythonResult = ParseResultObject(
        Bridge->TestOnlyBuildWebUIHealthResponse(TEXT("0.1.1"), false));
    TestEqual(
        TEXT("An available Python pointer maps to the available enum"),
        AvailablePythonResult.IsValid() ? AvailablePythonResult->GetStringField(TEXT("pythonRuntime")) : FString(),
        FString(TEXT("available")));
    TestEqual(
        TEXT("A missing Python pointer maps to the unavailable enum"),
        UnavailablePythonResult.IsValid() ? UnavailablePythonResult->GetStringField(TEXT("pythonRuntime")) : FString(),
        FString(TEXT("unavailable")));

    const FString ExactVersionLimit = FString::ChrN(64, TEXT('A'));
    const TSharedPtr<FJsonObject> ExactVersionResult = ParseResultObject(
        Bridge->TestOnlyBuildWebUIHealthResponse(ExactVersionLimit, true));
    TestEqual(
        TEXT("A canonical plugin version exactly at 64 characters is accepted"),
        ExactVersionResult.IsValid() ? ExactVersionResult->GetStringField(TEXT("pluginVersion")) : FString(),
        ExactVersionLimit);

    const TArray<FString> InvalidPluginVersions = {
        FString(),
        FString::ChrN(65, TEXT('A')),
        TEXT("0.1.1+build"),
        TEXT("0.1_1"),
        TEXT("0.1.1/secret"),
        TEXT(".0.1.1"),
        TEXT("0.1.1-"),
        TEXT("0..1"),
        TEXT("0.-1"),
        TEXT("0.1.1-\u79C1\u5BC6"),
    };
    for (int32 Index = 0; Index < InvalidPluginVersions.Num(); ++Index)
    {
        const FString InvalidResponse = Bridge->TestOnlyBuildWebUIHealthResponse(
            InvalidPluginVersions[Index],
            true);
        TestEqual(
            *FString::Printf(TEXT("Invalid plugin version %d returns the fixed error code"), Index),
            GetResponseErrorCode(InvalidResponse),
            FString(TEXT("health_unavailable")));
        TestEqual(
            *FString::Printf(TEXT("Invalid plugin version %d returns the fixed error message"), Index),
            GetResponseErrorMessage(InvalidResponse),
            FString(TEXT("WebUI health is unavailable.")));
    }

    const FString VersionCanary = TEXT("0.1.1-PRIVATE_CANARY");
    const FString InvalidCanaryResponse = Bridge->TestOnlyBuildWebUIHealthResponse(VersionCanary, true);
    TestEqual(
        TEXT("A non-canonical canary version fails closed"),
        GetResponseErrorCode(InvalidCanaryResponse),
        FString(TEXT("health_unavailable")));
    TestFalse(TEXT("The fixed health error redacts the invalid descriptor value"), InvalidCanaryResponse.Contains(VersionCanary));
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
