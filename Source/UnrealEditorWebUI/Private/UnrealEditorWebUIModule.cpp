#include "UnrealEditorWebUIBridge.h"
#include "UnrealEditorWebUISettings.h"

#include "Framework/Docking/TabManager.h"
#include "Modules/ModuleManager.h"
#include "Misc/Base64.h"
#include "SWebBrowser.h"
#include "ToolMenus.h"
#include "UObject/StrongObjectPtr.h"
#include "Widgets/Docking/SDockTab.h"

#define LOCTEXT_NAMESPACE "FUnrealEditorWebUIModule"

DEFINE_LOG_CATEGORY_STATIC(LogUnrealEditorWebUI, Log, All);

namespace UnrealEditorWebUI
{
    static const FName TabName(TEXT("UnrealEditorWebUI"));

    FString EncodeBase64Utf8(const FString& Value)
    {
        FTCHARToUTF8 Converter(*Value);
        return FBase64::Encode(reinterpret_cast<const uint8*>(Converter.Get()), Converter.Length());
    }
}

class FUnrealEditorWebUIModule final : public IModuleInterface
{
public:
    virtual void StartupModule() override
    {
        FGlobalTabmanager::Get()->RegisterNomadTabSpawner(
            UnrealEditorWebUI::TabName,
            FOnSpawnTab::CreateRaw(this, &FUnrealEditorWebUIModule::SpawnWebUITab))
            .SetDisplayName(LOCTEXT("TabTitle", "Unreal Editor WebUI"))
            .SetMenuType(ETabSpawnerMenuType::Hidden);

        UToolMenus::RegisterStartupCallback(
            FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FUnrealEditorWebUIModule::RegisterMenus));
    }

    virtual void ShutdownModule() override
    {
        if (UToolMenus::IsToolMenuUIEnabled())
        {
            UToolMenus::UnRegisterStartupCallback(this);
            UToolMenus::UnregisterOwner(this);
        }

        FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(UnrealEditorWebUI::TabName);
        if (BrowserWidget.IsValid() && Bridge.Get() != nullptr)
        {
            BrowserWidget->UnbindUObject(TEXT("editorwebui"), Bridge.Get(), false);
        }
        if (Bridge.Get() != nullptr)
        {
            Bridge->BeginDocumentSession(TEXT("module-shutdown"));
        }
        BrowserWidget.Reset();
        Bridge.Reset();
    }

private:
    void RegisterMenus()
    {
        FToolMenuOwnerScoped OwnerScoped(this);

        UToolMenu* WindowMenu = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.MainMenu.Window"));
        FToolMenuSection& Section = WindowMenu->FindOrAddSection(TEXT("WindowLayout"));

        Section.AddMenuEntry(
            TEXT("OpenUnrealEditorWebUI"),
            LOCTEXT("OpenMenuLabel", "Unreal Editor WebUI"),
            LOCTEXT("OpenMenuTooltip", "Open the Unreal Editor WebUI panel."),
            FSlateIcon(),
            FUIAction(FExecuteAction::CreateRaw(this, &FUnrealEditorWebUIModule::OpenWebUITab)));
    }

    void OpenWebUITab()
    {
        FGlobalTabmanager::Get()->TryInvokeTab(UnrealEditorWebUI::TabName);
    }

    void DispatchWebUIEvent(const FString& EventJson)
    {
        if (!BrowserWidget.IsValid())
        {
            return;
        }

        const FString EncodedEventJson = UnrealEditorWebUI::EncodeBase64Utf8(EventJson);
        const FString Script = FString::Printf(TEXT(
            "(function(){"
            "var encoded='%s';"
            "var binary=atob(encoded);"
            "var json=(typeof TextDecoder==='function')"
            "?new TextDecoder('utf-8').decode(Uint8Array.from(binary,function(c){return c.charCodeAt(0);}))"
            ":decodeURIComponent(escape(binary));"
            "var detail=JSON.parse(json);"
            "window.dispatchEvent(new CustomEvent('unreal-editor-webui',{detail:detail}));"
            "if(window.UnrealEditorWebUI&&typeof window.UnrealEditorWebUI.onEvent==='function'){"
            "window.UnrealEditorWebUI.onEvent(detail);"
            "}"
            "})();"),
            *EncodedEventJson);

        BrowserWidget->ExecuteJavascript(Script);
    }

    void HandleBrowserUrlChanged(const FText& NewUrlText)
    {
        const FString NewUrl = NewUrlText.ToString();
        if (bLoadingBootstrapPage && NewUrl.Equals(TEXT("about:blank"), ESearchCase::IgnoreCase))
        {
            return;
        }

        FString Error;
        if (UnrealEditorWebUISettings::IsBridgeURLAllowedForStartupScope(NewUrl, TrustedStartupURL, Error))
        {
            bLoadingBootstrapPage = false;
            if (!LastAllowedURL.IsEmpty() && !NewUrl.Equals(LastAllowedURL, ESearchCase::CaseSensitive) && Bridge.Get() != nullptr)
            {
                Bridge->ResetPrivilegedCommandApprovals();
            }
            LastAllowedURL = NewUrl;
            return;
        }

        UE_LOG(LogUnrealEditorWebUI, Warning, TEXT("Blocked unsafe WebUI navigation to '%s': %s"), *NewUrl, *Error);

        if (BrowserWidget.IsValid())
        {
            const FString FallbackURL = LastAllowedURL.IsEmpty()
                ? UnrealEditorWebUISettings::ResolveStartupURL()
                : LastAllowedURL;
            BrowserWidget->LoadURL(FallbackURL);
        }
    }

    bool HandleBeforeNavigation(const FString& URL, const FWebNavigationRequest&)
    {
        if (bLoadingBootstrapPage && URL.Equals(TEXT("about:blank"), ESearchCase::IgnoreCase))
        {
            return false;
        }

        FString Error;
        if (UnrealEditorWebUISettings::IsBridgeURLAllowedForStartupScope(URL, TrustedStartupURL, Error))
        {
            if (!LastAllowedURL.IsEmpty() && !URL.Equals(LastAllowedURL, ESearchCase::CaseSensitive) && Bridge.Get() != nullptr)
            {
                Bridge->ResetPrivilegedCommandApprovals();
            }
            return false;
        }

        UE_LOG(LogUnrealEditorWebUI, Warning, TEXT("Blocked unsafe WebUI navigation request to '%s': %s"), *URL, *Error);
        return true;
    }

    void HandleBrowserLoadStarted()
    {
        if (Bridge.Get() != nullptr && BrowserWidget.IsValid())
        {
            if (bLoadingBootstrapPage
                && BrowserWidget->GetUrl().Equals(TEXT("about:blank"), ESearchCase::IgnoreCase))
            {
                return;
            }

            Bridge->BeginDocumentSession(
                LastAllowedURL.IsEmpty() ? TrustedStartupURL : LastAllowedURL);
            // Temporary bindings are destroyed with their document context.
            // Register from OnLoadStarted so an old page cannot call into the
            // bridge after a new document session has begun.
            BrowserWidget->BindUObject(TEXT("editorwebui"), Bridge.Get(), false);
        }
    }

    void HandleBrowserLoadCompleted()
    {
        if (Bridge.Get() == nullptr || !BrowserWidget.IsValid())
        {
            return;
        }

        const FString LoadedURL = BrowserWidget->GetUrl();
        if (bLoadingBootstrapPage && LoadedURL.Equals(TEXT("about:blank"), ESearchCase::IgnoreCase))
        {
            return;
        }

        FString Error;
        if (!UnrealEditorWebUISettings::IsBridgeURLAllowedForStartupScope(
                LoadedURL,
                TrustedStartupURL,
                Error))
        {
            UE_LOG(
                LogUnrealEditorWebUI,
                Warning,
                TEXT("Refused to bind the WebUI bridge after loading unsafe URL '%s': %s"),
                *LoadedURL,
                *Error);
            return;
        }
        bLoadingBootstrapPage = false;

        // UE 5.8 can deliver the Loading notification before the new renderer
        // context accepts a temporary binding. Replace it once the validated
        // document is ready, then notify clients that support delayed binding.
        BrowserWidget->UnbindUObject(TEXT("editorwebui"), Bridge.Get(), false);
        BrowserWidget->BindUObject(TEXT("editorwebui"), Bridge.Get(), false);
        BrowserWidget->ExecuteJavascript(TEXT(
            "(function(){"
            "var attempts=0;"
            "function signal(){"
            "if(window.ue&&window.ue.editorwebui){"
            "document.dispatchEvent(new CustomEvent('ue:ready',{detail:window.ue}));"
            "}else if(++attempts<500){setTimeout(signal,10);}"
            "}"
            "signal();"
            "})();"));
    }

    TSharedRef<SDockTab> SpawnWebUITab(const FSpawnTabArgs& SpawnTabArgs)
    {
        static_cast<void>(SpawnTabArgs);
        if (BrowserWidget.IsValid() && Bridge.Get() != nullptr)
        {
            BrowserWidget->UnbindUObject(TEXT("editorwebui"), Bridge.Get(), false);
        }
        if (Bridge.Get() != nullptr)
        {
            Bridge->BeginDocumentSession(TEXT("tab-replaced"));
        }
        BrowserWidget.Reset();
        Bridge = TStrongObjectPtr<UUnrealEditorWebUIBridge>(NewObject<UUnrealEditorWebUIBridge>());
        LastAllowedURL = GetInitialURL();
        TrustedStartupURL = LastAllowedURL;
        bLoadingBootstrapPage = true;
        Bridge->BeginDocumentSession(TrustedStartupURL);

        SAssignNew(BrowserWidget, SWebBrowser)
            // SWebBrowserView creates its browser window before subscribing to
            // document-state changes. A disposable first page ensures the
            // trusted load reaches the registered completion callback, where
            // UE 5.8's renderer binding is refreshed for that document.
            .InitialURL(TEXT("about:blank"))
            .ShowControls(false)
            .SupportsTransparency(true)
            .OnBeforeNavigation(SWebBrowser::FOnBeforeBrowse::CreateRaw(this, &FUnrealEditorWebUIModule::HandleBeforeNavigation))
            .OnLoadStarted(FSimpleDelegate::CreateRaw(this, &FUnrealEditorWebUIModule::HandleBrowserLoadStarted))
            .OnLoadCompleted(FSimpleDelegate::CreateRaw(this, &FUnrealEditorWebUIModule::HandleBrowserLoadCompleted))
            .OnUrlChanged(FOnTextChanged::CreateRaw(this, &FUnrealEditorWebUIModule::HandleBrowserUrlChanged));

        Bridge->SetEventDispatcher([this](const FString& EventJson)
        {
            DispatchWebUIEvent(EventJson);
        });
        BrowserWidget->LoadURL(LastAllowedURL);

        return SNew(SDockTab)
            .TabRole(ETabRole::NomadTab)
            [
                BrowserWidget.ToSharedRef()
            ];
    }

    FString GetInitialURL() const
    {
        return UnrealEditorWebUISettings::ResolveStartupURL();
    }

private:
    TSharedPtr<SWebBrowser> BrowserWidget;
    TStrongObjectPtr<UUnrealEditorWebUIBridge> Bridge;
    FString LastAllowedURL;
    FString TrustedStartupURL;
    bool bLoadingBootstrapPage = false;
};

IMPLEMENT_MODULE(FUnrealEditorWebUIModule, UnrealEditorWebUI)

#undef LOCTEXT_NAMESPACE
