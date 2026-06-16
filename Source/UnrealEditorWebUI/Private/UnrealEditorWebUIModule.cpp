#include "UnrealEditorWebUIBridge.h"
#include "UnrealEditorWebUISettings.h"

#include "Framework/Docking/TabManager.h"
#include "Modules/ModuleManager.h"
#include "SWebBrowser.h"
#include "ToolMenus.h"
#include "UObject/StrongObjectPtr.h"
#include "Widgets/Docking/SDockTab.h"

#define LOCTEXT_NAMESPACE "FUnrealEditorWebUIModule"

namespace UnrealEditorWebUI
{
    static const FName TabName(TEXT("UnrealEditorWebUI"));

    FString EscapeJavaScriptString(const FString& Value)
    {
        FString Escaped = Value;
        Escaped.ReplaceInline(TEXT("\\"), TEXT("\\\\"));
        Escaped.ReplaceInline(TEXT("'"), TEXT("\\'"));
        Escaped.ReplaceInline(TEXT("\r"), TEXT("\\r"));
        Escaped.ReplaceInline(TEXT("\n"), TEXT("\\n"));
        return Escaped;
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

        const FString EscapedEventJson = UnrealEditorWebUI::EscapeJavaScriptString(EventJson);
        const FString Script = FString::Printf(TEXT(
            "(function(){"
            "var detail=JSON.parse('%s');"
            "window.dispatchEvent(new CustomEvent('unreal-editor-webui',{detail:detail}));"
            "if(window.UnrealEditorWebUI&&typeof window.UnrealEditorWebUI.onEvent==='function'){"
            "window.UnrealEditorWebUI.onEvent(detail);"
            "}"
            "})();"),
            *EscapedEventJson);

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
