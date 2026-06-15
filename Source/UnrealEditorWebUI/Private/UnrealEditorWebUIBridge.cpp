#include "UnrealEditorWebUIBridge.h"

#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "IPythonScriptPlugin.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Base64.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

DEFINE_LOG_CATEGORY_STATIC(LogUnrealEditorWebUIBridge, Log, All);

namespace
{
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

    FString MakeErrorResponse(const FString& RequestId, const FString& Code, const FString& Message)
    {
        const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
        if (RequestId.IsEmpty())
        {
            Root->SetField(TEXT("id"), MakeShared<FJsonValueNull>());
        }
        else
        {
            Root->SetStringField(TEXT("id"), RequestId);
        }

        Root->SetBoolField(TEXT("ok"), false);

        const TSharedRef<FJsonObject> Error = MakeShared<FJsonObject>();
        Error->SetStringField(TEXT("code"), Code);
        Error->SetStringField(TEXT("message"), Message);
        Root->SetObjectField(TEXT("error"), Error);

        return WriteJsonObject(Root);
    }

    FString EncodeBase64Utf8(const FString& Value)
    {
        FTCHARToUTF8 Converter(*Value);
        return FBase64::Encode(reinterpret_cast<const uint8*>(Converter.Get()), Converter.Length());
    }
}

void UUnrealEditorWebUIBridge::PostMessage(const FString& Payload)
{
    UE_LOG(LogUnrealEditorWebUIBridge, Log, TEXT("WebUI message: %s"), *Payload);
}

FString UUnrealEditorWebUIBridge::ExecuteCommand(const FString& RequestJson)
{
    const FString RequestId = ExtractRequestId(RequestJson);

    if (RequestJson.IsEmpty())
    {
        return MakeErrorResponse(RequestId, TEXT("invalid_request"), TEXT("Request JSON cannot be empty."));
    }

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

    const FString PythonCode = FString::Printf(TEXT(
        "import base64, json, pathlib, sys, traceback\n"
        "request_id = None\n"
        "result_path = pathlib.Path(base64.b64decode('%s').decode('utf-8'))\n"
        "try:\n"
        "    plugin_python_dir = base64.b64decode('%s').decode('utf-8')\n"
        "    request_json = base64.b64decode('%s').decode('utf-8')\n"
        "    try:\n"
        "        parsed_request = json.loads(request_json)\n"
        "        request_id = parsed_request.get('id')\n"
        "    except Exception:\n"
        "        pass\n"
        "    if plugin_python_dir not in sys.path:\n"
        "        sys.path.insert(0, plugin_python_dir)\n"
        "    from unreal_editor_webui_registry import execute_command\n"
        "    response_json = execute_command(request_json)\n"
        "    result_path.write_text(response_json, encoding='utf-8')\n"
        "except Exception as exc:\n"
        "    response = {\n"
        "        'id': request_id,\n"
        "        'ok': False,\n"
        "        'error': {\n"
        "            'code': 'python_exception',\n"
        "            'message': str(exc),\n"
        "            'traceback': traceback.format_exc(),\n"
        "        },\n"
        "    }\n"
        "    result_path.write_text(json.dumps(response, ensure_ascii=False), encoding='utf-8')\n"),
        *EncodedResultPath,
        *EncodedPythonDir,
        *EncodedRequestJson);

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
