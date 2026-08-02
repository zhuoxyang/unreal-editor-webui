#if WITH_DEV_AUTOMATION_TESTS

#include "Framework/Application/SlateApplication.h"
#include "Framework/Docking/TabManager.h"
#include "HAL/PlatformTime.h"
#include "Misc/AutomationTest.h"
#include "Misc/Guid.h"
#include "SWebBrowser.h"
#include "Widgets/Docking/SDockTab.h"

namespace
{
    constexpr double BrowserTestTimeoutSeconds = 60.0;
    constexpr double BrowserInjectionIntervalSeconds = 0.5;
    const FName WebUITabName(TEXT("UnrealEditorWebUI"));

    FString BuildBrowserTestScript(const FString& Nonce)
    {
        return FString::Printf(
            TEXT("(function(){")
            TEXT("var nonce='%s';")
            TEXT("var passTitle='UEWEBUI_E2E_PASS:'+nonce;")
            TEXT("var failTitle='UEWEBUI_E2E_FAIL:'+nonce+':';")
            TEXT("var waitTitle='UEWEBUI_E2E_WAIT:'+nonce+':';")
            TEXT("if(window.__unrealEditorWebUIE2E&&window.__unrealEditorWebUIE2E.nonce===nonce){return;}")
            TEXT("var state={nonce:nonce,events:[],started:false,verifying:false,taskId:null,readySince:0};")
            TEXT("window.__unrealEditorWebUIE2E=state;")
            TEXT("function phase(value){document.title=waitTitle+value;}")
            TEXT("phase('injected');")
            TEXT("function bridge(){return window.ue&&window.ue.editorwebui;}")
            TEXT("function fail(value){var text=String(value&&value.message?value.message:value||'unknown');")
            TEXT("document.title=failTitle+text.replace(/[^A-Za-z0-9_.:-]/g,'_').slice(0,120);}")
            TEXT("function completedEvent(){return state.events.some(function(item){")
            TEXT("return item&&item.type==='task.status'&&item.taskId===state.taskId&&item.status==='completed';});}")
            TEXT("function reactBridgeReady(){var element=document.querySelector('.status.ready');")
            TEXT("return !!element&&(element.textContent||'').trim()==='Bridge ready';}")
            TEXT("function renderedCompletedEvent(){return Array.prototype.some.call(document.querySelectorAll('.log-panel'),function(panel){")
            TEXT("var heading=panel.querySelector('h2');return heading&&(heading.textContent||'').trim()==='Message Log'")
            TEXT("&&(panel.textContent||'').indexOf('task.status '+state.taskId+' completed')!==-1;});}")
            TEXT("async function verify(){")
            TEXT("if(!state.taskId||state.verifying){return;}")
            TEXT("if(!completedEvent()){phase('task-event');return;}")
            TEXT("state.verifying=true;")
            TEXT("try{")
            TEXT("var rawTask=await bridge().gettask(state.taskId);")
            TEXT("var taskEnvelope=JSON.parse(rawTask);")
            TEXT("if(!taskEnvelope.ok||!taskEnvelope.result||taskEnvelope.result.status!=='completed'){throw new Error('task_not_completed');}")
            TEXT("var executionEnvelope=JSON.parse(taskEnvelope.result.responseJson||'{}');")
            TEXT("if(!executionEnvelope.ok||!executionEnvelope.result||executionEnvelope.result.message!=='pong'){throw new Error('missing_pong');}")
            TEXT("if(!executionEnvelope.result.echo||executionEnvelope.result.echo.nonce!==nonce){throw new Error('nonce_mismatch');}")
            TEXT("var card=document.querySelector('[data-task-id=\"'+state.taskId+'\"]');")
            TEXT("if(!card||!card.querySelector('.badge.completed')){phase('task-card');state.verifying=false;return;}")
            TEXT("if(!renderedCompletedEvent()){phase('message-log');state.verifying=false;return;}")
            TEXT("document.title=passTitle;")
            TEXT("}catch(error){fail(error);}")
            TEXT("}")
            TEXT("window.addEventListener('unreal-editor-webui',function(event){")
            TEXT("state.events.push(event.detail);void verify();});")
            TEXT("async function start(){")
            TEXT("if(state.started){return;}")
            TEXT("if(!bridge()){phase('bridge');state.readySince=0;return;}")
            TEXT("if(!document.querySelector('.app-shell')){phase('react');state.readySince=0;return;}")
            TEXT("if(!reactBridgeReady()){phase('bridge-ready');state.readySince=0;return;}")
            TEXT("if(!state.readySince){phase('settling');state.readySince=Date.now();return;}")
            TEXT("if(Date.now()-state.readySince<500){phase('settling');return;}")
            TEXT("var pagePath=(window.location.pathname||'').toLowerCase();")
            TEXT("if(window.location.protocol!=='file:'||!pagePath.endsWith('/plugins/unrealeditorwebui/web/dist/index.html')){")
            TEXT("fail('unexpected_packaged_page');return;}")
            TEXT("state.started=true;")
            TEXT("try{")
            TEXT("var request=JSON.stringify({id:'cef-e2e-'+nonce,command:'system.ping',payload:{source:'cef-e2e',nonce:nonce}});")
            TEXT("var rawStart=await bridge().startcommand(request);")
            TEXT("var startEnvelope=JSON.parse(rawStart);")
            TEXT("if(!startEnvelope.ok||!startEnvelope.result||!startEnvelope.result.taskId){throw new Error('start_failed');}")
            TEXT("state.taskId=startEnvelope.result.taskId;")
            TEXT("phase('task-event');")
            TEXT("void verify();")
            TEXT("}catch(error){fail(error);}")
            TEXT("}")
            TEXT("document.addEventListener('ue:ready',function(){void start();});")
            TEXT("window.setInterval(function(){void start();void verify();},100);")
            TEXT("void start();")
            TEXT("})();"),
            *Nonce);
    }

    class FUnrealEditorWebUIBrowserRoundTripCommand final : public IAutomationLatentCommand
    {
    public:
        explicit FUnrealEditorWebUIBrowserRoundTripCommand(FAutomationTestBase* InTest)
            : Test(InTest)
            , Nonce(FGuid::NewGuid().ToString(EGuidFormats::Digits))
            , StartedAt(FPlatformTime::Seconds())
            , LastInjectionAt(0.0)
        {
        }

        virtual bool Update() override
        {
            const double Now = FPlatformTime::Seconds();
            if (!BrowserWidget.IsValid())
            {
                if (!FSlateApplication::IsInitialized())
                {
                    Test->AddError(TEXT("Slate is not initialized; the browser test requires an interactive editor session."));
                    return true;
                }

                Tab = FGlobalTabmanager::Get()->TryInvokeTab(WebUITabName);
                if (!Tab.IsValid())
                {
                    Test->AddError(TEXT("Could not open the Unreal Editor WebUI tab."));
                    return true;
                }

                const TSharedRef<SWidget> Content = Tab->GetContent();
                if (Content->GetType() != FName(TEXT("SWebBrowser")))
                {
                    Test->AddError(FString::Printf(
                        TEXT("The Unreal Editor WebUI tab contains '%s', expected SWebBrowser."),
                        *Content->GetTypeAsString()));
                    Tab->RequestCloseTab();
                    return true;
                }

                BrowserWidget = StaticCastSharedRef<SWebBrowser>(Content);
            }

            const FString Title = BrowserWidget->GetTitleText().ToString();
            const FString PassTitle = FString::Printf(TEXT("UEWEBUI_E2E_PASS:%s"), *Nonce);
            const FString FailPrefix = FString::Printf(TEXT("UEWEBUI_E2E_FAIL:%s:"), *Nonce);
            if (Title == PassTitle)
            {
                Test->AddInfo(TEXT("Packaged React page, CEF JavaScript binding, React bridge-ready state, system.ping task, DOM event log, and TaskCard round trip passed."));
                Tab->RequestCloseTab();
                return true;
            }
            if (Title.StartsWith(FailPrefix))
            {
                Test->AddError(FString::Printf(TEXT("Browser round trip failed: %s"), *Title.Mid(FailPrefix.Len())));
                Tab->RequestCloseTab();
                return true;
            }

            if (Now - StartedAt >= BrowserTestTimeoutSeconds)
            {
                Test->AddError(FString::Printf(
                    TEXT("Timed out waiting for the CEF round trip. Loaded=%s URL='%s' title='%s'."),
                    BrowserWidget->IsLoaded() ? TEXT("true") : TEXT("false"),
                    *BrowserWidget->GetUrl(),
                    *Title));
                Tab->RequestCloseTab();
                return true;
            }

            if (Now - LastInjectionAt >= BrowserInjectionIntervalSeconds)
            {
                BrowserWidget->ExecuteJavascript(BuildBrowserTestScript(Nonce));
                LastInjectionAt = Now;
            }

            return false;
        }

    private:
        FAutomationTestBase* Test;
        FString Nonce;
        double StartedAt;
        double LastInjectionAt;
        TSharedPtr<SDockTab> Tab;
        TSharedPtr<SWebBrowser> BrowserWidget;
    };
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUnrealEditorWebUIBrowserBindingAndTaskEventTest,
    "UnrealEditorWebUI.Browser.CEFBindingAndTaskEvent",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::NonNullRHI | EAutomationTestFlags::EngineFilter)

bool FUnrealEditorWebUIBrowserBindingAndTaskEventTest::RunTest(const FString& Parameters)
{
    static_cast<void>(Parameters);
    ADD_LATENT_AUTOMATION_COMMAND(FUnrealEditorWebUIBrowserRoundTripCommand(this));
    return true;
}

#endif
