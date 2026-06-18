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

    TSharedRef<SDockTab> SpawnWebUITab(const FSpawnTabArgs& SpawnTabArgs)
    {
        Bridge = TStrongObjectPtr<UUnrealEditorWebUIBridge>(NewObject<UUnrealEditorWebUIBridge>());

        BrowserWidget =
            SNew(SWebBrowser)
            .InitialURL(GetInitialURL())
            .ShowControls(false)
            .SupportsTransparency(true);

        BrowserWidget->BindUObject(TEXT("editorwebui"), Bridge.Get(), true);
        Bridge->SetEventDispatcher([this](const FString& EventJson)
        {
            DispatchWebUIEvent(EventJson);
        });

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
};

IMPLEMENT_MODULE(FUnrealEditorWebUIModule, UnrealEditorWebUI)

#undef LOCTEXT_NAMESPACE
