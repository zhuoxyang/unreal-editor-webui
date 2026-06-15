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

    TSharedRef<SDockTab> SpawnWebUITab(const FSpawnTabArgs& SpawnTabArgs)
    {
        Bridge = TStrongObjectPtr<UUnrealEditorWebUIBridge>(NewObject<UUnrealEditorWebUIBridge>());

        BrowserWidget =
            SNew(SWebBrowser)
            .InitialURL(GetInitialURL())
            .ShowControls(false)
            .SupportsTransparency(true);

        BrowserWidget->BindUObject(TEXT("editorwebui"), Bridge.Get(), true);

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
