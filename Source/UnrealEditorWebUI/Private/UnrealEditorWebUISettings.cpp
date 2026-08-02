#include "UnrealEditorWebUISettings.h"

#include "Dom/JsonObject.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/MessageDialog.h"
#include "Misc/Paths.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/UnrealType.h"

DEFINE_LOG_CATEGORY_STATIC(LogUnrealEditorWebUISettings, Log, All);

namespace
{
    constexpr const TCHAR* SettingsSection = TEXT("UnrealEditorWebUI");

    bool ExtractUrlSchemeAndAuthority(const FString& Url, FString& OutScheme, FString& OutAuthority)
    {
        FString Trimmed = Url;
        Trimmed.TrimStartAndEndInline();

        int32 SchemeSeparator = INDEX_NONE;
        if (!Trimmed.FindChar(TEXT(':'), SchemeSeparator) || SchemeSeparator <= 0)
        {
            return false;
        }

        OutScheme = Trimmed.Left(SchemeSeparator).ToLower();
        if (!Trimmed.Mid(SchemeSeparator).StartsWith(TEXT("://")))
        {
            return false;
        }

        FString Remainder = Trimmed.Mid(SchemeSeparator + 3);
        int32 AuthorityEnd = Remainder.Len();
        for (const TCHAR Delimiter : {TEXT('/'), TEXT('?'), TEXT('#')})
        {
            int32 DelimiterIndex = INDEX_NONE;
            if (Remainder.FindChar(Delimiter, DelimiterIndex))
            {
                AuthorityEnd = FMath::Min(AuthorityEnd, DelimiterIndex);
            }
        }

        OutAuthority = Remainder.Left(AuthorityEnd);
        return !OutAuthority.IsEmpty();
    }

    bool TryNormalizeLoopbackAuthority(
        FString Authority,
        const FString& Scheme,
        FString& OutAuthority)
    {
        for (const TCHAR Character : Authority)
        {
            if (FChar::IsWhitespace(Character))
            {
                return false;
            }
        }

        int32 UserInfoSeparator = INDEX_NONE;
        if (Authority.FindLastChar(TEXT('@'), UserInfoSeparator))
        {
            return false;
        }

        FString Host;
        FString Port;
        bool bHasExplicitPort = false;
        if (Authority.StartsWith(TEXT("[")))
        {
            int32 ClosingBracket = INDEX_NONE;
            if (!Authority.FindChar(TEXT(']'), ClosingBracket) || ClosingBracket <= 1)
            {
                return false;
            }

            Host = Authority.Mid(1, ClosingBracket - 1);
            const FString PortSuffix = Authority.Mid(ClosingBracket + 1);
            if (!PortSuffix.IsEmpty())
            {
                if (!PortSuffix.StartsWith(TEXT(":")))
                {
                    return false;
                }
                bHasExplicitPort = true;
                Port = PortSuffix.Mid(1);
            }
        }
        else
        {
            int32 PortSeparator = INDEX_NONE;
            if (Authority.FindChar(TEXT(':'), PortSeparator))
            {
                bHasExplicitPort = true;
                Host = Authority.Left(PortSeparator);
                Port = Authority.Mid(PortSeparator + 1);
                if (Port.Contains(TEXT(":")))
                {
                    return false;
                }
            }
            else
            {
                Host = Authority;
            }
        }

        Host.TrimStartAndEndInline();
        Host = Host.ToLower();
        if (Host != TEXT("localhost") && Host != TEXT("127.0.0.1") && Host != TEXT("::1"))
        {
            return false;
        }

        if (bHasExplicitPort && Port.IsEmpty())
        {
            return false;
        }

        int32 PortNumber = Scheme == TEXT("https") ? 443 : 80;
        if (!Port.IsEmpty())
        {
            for (const TCHAR Character : Port)
            {
                if (!FChar::IsDigit(Character))
                {
                    return false;
                }
            }

            PortNumber = FCString::Atoi(*Port);
            if (PortNumber <= 0 || PortNumber > 65535)
            {
                return false;
            }
        }

        const FString CanonicalHost = Host == TEXT("::1")
            ? TEXT("[::1]")
            : Host;
        OutAuthority = FString::Printf(TEXT("%s:%d"), *CanonicalHost, PortNumber);
        return true;
    }

    bool IsPackagedWebFileURL(const FString& Url)
    {
        const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("UnrealEditorWebUI"));
        if (!Plugin.IsValid())
        {
            return false;
        }

        FString EncodedFilePath = Url.Mid(7);
        int32 SuffixIndex = INDEX_NONE;
        for (const TCHAR Delimiter : {TEXT('?'), TEXT('#')})
        {
            int32 DelimiterIndex = INDEX_NONE;
            if (EncodedFilePath.FindChar(Delimiter, DelimiterIndex))
            {
                SuffixIndex = SuffixIndex == INDEX_NONE
                    ? DelimiterIndex
                    : FMath::Min(SuffixIndex, DelimiterIndex);
            }
        }
        if (SuffixIndex != INDEX_NONE)
        {
            EncodedFilePath = EncodedFilePath.Left(SuffixIndex);
        }

        FString FilePath = FGenericPlatformHttp::UrlDecode(EncodedFilePath);
#if PLATFORM_WINDOWS
        if (FilePath.Len() > 2 && FilePath[0] == TEXT('/') && FilePath[2] == TEXT(':'))
        {
            FilePath = FilePath.Mid(1);
        }
#endif

        FilePath = FPaths::ConvertRelativePathToFull(FilePath);
        if (!FPaths::CollapseRelativeDirectories(FilePath))
        {
            return false;
        }
        FPaths::NormalizeFilename(FilePath);

        FString AllowedWebDir = FPaths::ConvertRelativePathToFull(
            FPaths::Combine(Plugin->GetBaseDir(), TEXT("Web")));
        if (!FPaths::CollapseRelativeDirectories(AllowedWebDir))
        {
            return false;
        }
        FPaths::NormalizeDirectoryName(AllowedWebDir);

        return FilePath == AllowedWebDir || FilePath.StartsWith(AllowedWebDir + TEXT("/"));
    }

    bool IsAllowedBridgeURL(const FString& Url)
    {
        FString Trimmed = Url;
        Trimmed.TrimStartAndEndInline();
        if (Trimmed.IsEmpty())
        {
            return true;
        }

        const FString LowerUrl = Trimmed.ToLower();
        if (LowerUrl == TEXT("about:blank"))
        {
            return true;
        }

        if (LowerUrl.StartsWith(TEXT("file://")))
        {
            return IsPackagedWebFileURL(Trimmed);
        }

        FString Scheme;
        FString Authority;
        if (!ExtractUrlSchemeAndAuthority(Trimmed, Scheme, Authority))
        {
            return false;
        }

        if (Scheme == TEXT("http") || Scheme == TEXT("https"))
        {
            FString NormalizedAuthority;
            return TryNormalizeLoopbackAuthority(Authority, Scheme, NormalizedAuthority);
        }

        return false;
    }

    bool GetBridgeSecurityScope(const FString& Url, FString& OutScope)
    {
        FString Trimmed = Url;
        Trimmed.TrimStartAndEndInline();
        const FString LowerUrl = Trimmed.ToLower();

        if (Trimmed.IsEmpty() || LowerUrl == TEXT("about:blank"))
        {
            OutScope = TEXT("about:blank");
            return true;
        }

        if (LowerUrl.StartsWith(TEXT("file://")))
        {
            if (!IsPackagedWebFileURL(Trimmed))
            {
                return false;
            }

            OutScope = TEXT("packaged-web");
            return true;
        }

        FString Scheme;
        FString Authority;
        FString NormalizedAuthority;
        if (!ExtractUrlSchemeAndAuthority(Trimmed, Scheme, Authority)
            || (Scheme != TEXT("http") && Scheme != TEXT("https"))
            || !TryNormalizeLoopbackAuthority(Authority, Scheme, NormalizedAuthority))
        {
            return false;
        }

        OutScope = FString::Printf(TEXT("%s://%s"), *Scheme, *NormalizedAuthority);
        return true;
    }

    bool ValidateStartupURL(const FString& FieldName, FString& InOutUrl, FString& OutError)
    {
        InOutUrl.TrimStartAndEndInline();
        if (IsAllowedBridgeURL(InOutUrl))
        {
            return true;
        }

        OutError = FString::Printf(
            TEXT("%s must be empty, about:blank, a packaged Web/ file URL, or an http(s) loopback URL such as http://localhost:5173."),
            *FieldName);
        return false;
    }

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

    FString WriteSettingsJsonObject(const TSharedRef<FJsonObject>& JsonObject)
    {
        FString Output;
        const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
            TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output);
        FJsonSerializer::Serialize(JsonObject, Writer);
        return Output;
    }

    void ApplyLegacyConfig(FUnrealEditorWebUISettings& Settings)
    {
        if (GConfig == nullptr)
        {
            return;
        }

        bool bUseDevServer = false;
        if (GConfig->GetBool(SettingsSection, TEXT("bUseDevServer"), bUseDevServer, GEditorPerProjectIni))
        {
            Settings.bUseDevServer = bUseDevServer;
        }

        FString DevServerURL;
        if (GConfig->GetString(SettingsSection, TEXT("DevServerURL"), DevServerURL, GEditorPerProjectIni))
        {
            Settings.DevServerURL = DevServerURL;
        }

        FString StartupURL;
        if (GConfig->GetString(SettingsSection, TEXT("StartupURL"), StartupURL, GEditorPerProjectIni))
        {
            Settings.StartupURL = StartupURL;
        }
    }

    void SaveLegacyConfig(const FUnrealEditorWebUISettings& Settings)
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
}

void UUnrealEditorWebUIEditorSettings::PostInitProperties()
{
    Super::PostInitProperties();

    if (HasAnyFlags(RF_ClassDefaultObject))
    {
        FUnrealEditorWebUISettings RuntimeSettings = ToRuntimeSettings();
        ApplyLegacyConfig(RuntimeSettings);
        ApplyRuntimeSettings(RuntimeSettings);
    }
}

#if WITH_EDITOR
FName UUnrealEditorWebUIEditorSettings::GetContainerName() const
{
    return FName(TEXT("Project"));
}

FName UUnrealEditorWebUIEditorSettings::GetCategoryName() const
{
    return FName(TEXT("Plugins"));
}

FName UUnrealEditorWebUIEditorSettings::GetSectionName() const
{
    return FName(TEXT("UnrealEditorWebUI"));
}

FText UUnrealEditorWebUIEditorSettings::GetSectionText() const
{
    return NSLOCTEXT("UnrealEditorWebUISettings", "SectionText", "Unreal Editor WebUI");
}

FText UUnrealEditorWebUIEditorSettings::GetSectionDescription() const
{
    return NSLOCTEXT(
        "UnrealEditorWebUISettings",
        "SectionDescription",
        "Configure the embedded Unreal Editor WebUI startup URL and loopback development server.");
}

void UUnrealEditorWebUIEditorSettings::PostEditChangeProperty(FPropertyChangedEvent& PropertyChangedEvent)
{
    Super::PostEditChangeProperty(PropertyChangedEvent);

    FUnrealEditorWebUISettings RuntimeSettings = ToRuntimeSettings();
    FUnrealEditorWebUISettings PreviousSettings;
    ApplyLegacyConfig(PreviousSettings);

    TArray<FString> ValidationErrors;

    FString DevServerURLCopy = RuntimeSettings.DevServerURL;
    FString StartupURLCopy = RuntimeSettings.StartupURL;
    FString Error;
    if (!ValidateStartupURL(TEXT("DevServerURL"), DevServerURLCopy, Error))
    {
        UE_LOG(LogUnrealEditorWebUISettings, Warning, TEXT("%s"), *Error);
        ValidationErrors.Add(Error);
        RuntimeSettings.DevServerURL = PreviousSettings.DevServerURL;
    }
    else
    {
        RuntimeSettings.DevServerURL = DevServerURLCopy;
    }

    if (!ValidateStartupURL(TEXT("StartupURL"), StartupURLCopy, Error))
    {
        UE_LOG(LogUnrealEditorWebUISettings, Warning, TEXT("%s"), *Error);
        ValidationErrors.Add(Error);
        RuntimeSettings.StartupURL = PreviousSettings.StartupURL;
    }
    else
    {
        RuntimeSettings.StartupURL = StartupURLCopy;
    }

    if (!ValidationErrors.IsEmpty())
    {
        ApplyRuntimeSettings(RuntimeSettings);

        const FText Title = NSLOCTEXT("UnrealEditorWebUISettings", "InvalidSettingsTitle", "Invalid WebUI Settings");
        const FText Message = FText::FromString(FString::Printf(
            TEXT("%s\n\nThe invalid value was reverted to the last saved setting."),
            *FString::Join(ValidationErrors, TEXT("\n"))));
        FMessageDialog::Open(EAppMsgType::Ok, Message, Title);
    }

    SaveConfig();
    SaveLegacyConfig(RuntimeSettings);
}
#endif

FUnrealEditorWebUISettings UUnrealEditorWebUIEditorSettings::ToRuntimeSettings() const
{
    FUnrealEditorWebUISettings RuntimeSettings;
    RuntimeSettings.bUseDevServer = bUseDevServer;
    RuntimeSettings.DevServerURL = DevServerURL;
    RuntimeSettings.StartupURL = StartupURL;
    return RuntimeSettings;
}

void UUnrealEditorWebUIEditorSettings::ApplyRuntimeSettings(const FUnrealEditorWebUISettings& Settings)
{
    bUseDevServer = Settings.bUseDevServer;
    DevServerURL = Settings.DevServerURL;
    StartupURL = Settings.StartupURL;
}

namespace UnrealEditorWebUISettings
{
    FUnrealEditorWebUISettings Load()
    {
        const UUnrealEditorWebUIEditorSettings* NativeSettings = GetDefault<UUnrealEditorWebUIEditorSettings>();
        FUnrealEditorWebUISettings Settings = NativeSettings != nullptr
            ? NativeSettings->ToRuntimeSettings()
            : FUnrealEditorWebUISettings();

        ApplyLegacyConfig(Settings);
        return Settings;
    }

    void Save(const FUnrealEditorWebUISettings& Settings)
    {
        UUnrealEditorWebUIEditorSettings* NativeSettings = GetMutableDefault<UUnrealEditorWebUIEditorSettings>();
        if (NativeSettings != nullptr)
        {
            NativeSettings->ApplyRuntimeSettings(Settings);
            NativeSettings->SaveConfig();
        }

        SaveLegacyConfig(Settings);
    }

    FString ResolveStartupURL()
    {
        const FUnrealEditorWebUISettings Settings = Load();

        if (Settings.bUseDevServer && !Settings.DevServerURL.IsEmpty() && IsAllowedBridgeURL(Settings.DevServerURL))
        {
            return Settings.DevServerURL;
        }

        if (!Settings.StartupURL.IsEmpty() && IsAllowedBridgeURL(Settings.StartupURL))
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
        return WriteSettingsJsonObject(Root);
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
            if (!ValidateStartupURL(TEXT("devServerUrl"), DevServerURL, OutError))
            {
                return false;
            }

            OutSettings.DevServerURL = DevServerURL;
        }

        FString StartupURL;
        if (Root->TryGetStringField(TEXT("startupUrl"), StartupURL))
        {
            if (!ValidateStartupURL(TEXT("startupUrl"), StartupURL, OutError))
            {
                return false;
            }

            OutSettings.StartupURL = StartupURL;
        }

        return true;
    }

    bool IsBridgeURLAllowed(const FString& URL, FString& OutError)
    {
        FString URLCopy = URL;
        return ValidateStartupURL(TEXT("URL"), URLCopy, OutError);
    }

    bool IsBridgeURLAllowedForStartupScope(
        const FString& URL,
        const FString& StartupURL,
        FString& OutError)
    {
        FString CandidateScope;
        if (!GetBridgeSecurityScope(URL, CandidateScope))
        {
            OutError = TEXT("URL is not an allowed packaged Web file or loopback http(s) URL.");
            return false;
        }

        FString TrustedScope;
        if (!GetBridgeSecurityScope(StartupURL, TrustedScope))
        {
            OutError = TEXT("The configured startup URL does not define a valid bridge security scope.");
            return false;
        }

        if (!CandidateScope.Equals(TrustedScope, ESearchCase::CaseSensitive))
        {
            OutError = FString::Printf(
                TEXT("URL scope '%s' does not match the configured startup scope '%s'."),
                *CandidateScope,
                *TrustedScope);
            return false;
        }

        return true;
    }
}
