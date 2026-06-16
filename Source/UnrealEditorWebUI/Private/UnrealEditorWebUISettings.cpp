#include "UnrealEditorWebUISettings.h"

#include "Dom/JsonObject.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/Paths.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
    constexpr const TCHAR* SettingsSection = TEXT("UnrealEditorWebUI");

    FString BuildLocalFileURL()
    {
        const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("UnrealEditorWebUI"));
        if (!Plugin.IsValid())
        {
            return TEXT("about:blank");
        }

        FString IndexPath = FPaths::ConvertRelativePathToFull(
            FPaths::Combine(Plugin->GetBaseDir(), TEXT("Web"), TEXT("dist"), TEXT("index.html")));

        if (!FPaths::FileExists(IndexPath))
        {
            IndexPath = FPaths::ConvertRelativePathToFull(
                FPaths::Combine(Plugin->GetBaseDir(), TEXT("Web"), TEXT("index.html")));
        }

        const FString NormalizedPath = IndexPath.Replace(TEXT("\\"), TEXT("/"));

#if PLATFORM_WINDOWS
        return FString::Printf(TEXT("file:///%s"), *NormalizedPath);
#else
        return FString::Printf(TEXT("file://%s"), *NormalizedPath);
#endif
    }

    FString WriteJsonObject(const TSharedRef<FJsonObject>& JsonObject)
    {
        FString Output;
        const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
            TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output);
        FJsonSerializer::Serialize(JsonObject, Writer);
        return Output;
    }
}

namespace UnrealEditorWebUISettings
{
    FUnrealEditorWebUISettings Load()
    {
        FUnrealEditorWebUISettings Settings;

        if (GConfig != nullptr)
        {
            GConfig->GetBool(SettingsSection, TEXT("bUseDevServer"), Settings.bUseDevServer, GEditorPerProjectIni);
            GConfig->GetString(SettingsSection, TEXT("DevServerURL"), Settings.DevServerURL, GEditorPerProjectIni);
            GConfig->GetString(SettingsSection, TEXT("StartupURL"), Settings.StartupURL, GEditorPerProjectIni);
        }

        return Settings;
    }

    void Save(const FUnrealEditorWebUISettings& Settings)
    {
        if (GConfig == nullptr)
        {
            return;
        }

        GConfig->SetBool(SettingsSection, TEXT("bUseDevServer"), Settings.bUseDevServer, GEditorPerProjectIni);
        GConfig->SetString(SettingsSection, TEXT("DevServerURL"), *Settings.DevServerURL, GEditorPerProjectIni);
        GConfig->SetString(SettingsSection, TEXT("StartupURL"), *Settings.StartupURL, GEditorPerProjectIni);
        GConfig->Flush(false, GEditorPerProjectIni);
    }

    FString ResolveStartupURL()
    {
        const FUnrealEditorWebUISettings Settings = Load();

        if (Settings.bUseDevServer && !Settings.DevServerURL.IsEmpty())
        {
            return Settings.DevServerURL;
        }

        if (!Settings.StartupURL.IsEmpty())
        {
            return Settings.StartupURL;
        }

        return BuildLocalFileURL();
    }

    FString ToJson(const FUnrealEditorWebUISettings& Settings)
    {
        const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
        Root->SetBoolField(TEXT("useDevServer"), Settings.bUseDevServer);
        Root->SetStringField(TEXT("devServerUrl"), Settings.DevServerURL);
        Root->SetStringField(TEXT("startupUrl"), Settings.StartupURL);
        Root->SetStringField(TEXT("resolvedUrl"), ResolveStartupURL());
        return WriteJsonObject(Root);
    }

    bool FromJson(const FString& SettingsJson, FUnrealEditorWebUISettings& OutSettings, FString& OutError)
    {
        TSharedPtr<FJsonObject> Root;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(SettingsJson);

        if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
        {
            OutError = TEXT("Settings JSON must be an object.");
            return false;
        }

        OutSettings = Load();

        bool bUseDevServer = false;
        if (Root->TryGetBoolField(TEXT("useDevServer"), bUseDevServer))
        {
            OutSettings.bUseDevServer = bUseDevServer;
        }

        FString DevServerURL;
        if (Root->TryGetStringField(TEXT("devServerUrl"), DevServerURL))
        {
            OutSettings.DevServerURL = DevServerURL;
        }

        FString StartupURL;
        if (Root->TryGetStringField(TEXT("startupUrl"), StartupURL))
        {
            OutSettings.StartupURL = StartupURL;
        }

        return true;
    }
}
