#if WITH_DEV_AUTOMATION_TESTS

#include "Framework/Application/SlateApplication.h"
#include "Framework/Docking/TabManager.h"
#include "HAL/PlatformMisc.h"
#include "HAL/PlatformTime.h"
#include "Misc/AutomationTest.h"
#include "Misc/Guid.h"
#include "SWebBrowser.h"
#include "Widgets/Docking/SDockTab.h"

namespace
{
    constexpr double BrowserTestTimeoutSeconds = 60.0;
    constexpr double BrowserInjectionIntervalSeconds = 0.5;
    constexpr int32 MaxExpectedToolPackCount = 384;
    const FName WebUITabName(TEXT("UnrealEditorWebUI"));

    bool IsValidCatalogMarker(const FString& Marker)
    {
        if (Marker.Len() != 32)
        {
            return false;
        }

        for (const TCHAR Character : Marker)
        {
            if (!((Character >= TEXT('0') && Character <= TEXT('9'))
                || (Character >= TEXT('a') && Character <= TEXT('f'))))
            {
                return false;
            }
        }
        return true;
    }

    bool TryParseExpectedToolPackCount(const FString& Value, int32& OutCount)
    {
        if (Value.IsEmpty() || (Value.Len() > 1 && Value[0] == TEXT('0')))
        {
            return false;
        }

        int32 ParsedCount = 0;
        for (const TCHAR Character : Value)
        {
            if (Character < TEXT('0') || Character > TEXT('9'))
            {
                return false;
            }
            const int32 Digit = Character - TEXT('0');
            if (ParsedCount > (MaxExpectedToolPackCount - Digit) / 10)
            {
                return false;
            }
            ParsedCount = ParsedCount * 10 + Digit;
        }

        OutCount = ParsedCount;
        return true;
    }

    bool IsKnownBrowserFailureReason(const FString& Reason)
    {
        return Reason == TEXT("browser_assertion")
            || Reason == TEXT("report_schema")
            || Reason == TEXT("support_report_redaction")
            || Reason == TEXT("report_identity")
            || Reason == TEXT("overall_health")
            || Reason == TEXT("native_health")
            || Reason == TEXT("bridge_health")
            || Reason == TEXT("project_health")
            || Reason == TEXT("registry_health")
            || Reason == TEXT("catalog_health")
            || Reason == TEXT("tool_pack_health")
            || Reason == TEXT("task_counts")
            || Reason == TEXT("completed_task_count")
            || Reason == TEXT("initial_task_count")
            || Reason == TEXT("task_not_completed")
            || Reason == TEXT("missing_pong")
            || Reason == TEXT("nonce_mismatch")
            || Reason == TEXT("start_failed")
            || Reason == TEXT("unexpected_packaged_page");
    }

    bool IsKnownBrowserWaitPhase(const FString& Phase)
    {
        return Phase == TEXT("injected")
            || Phase == TEXT("health-toggle")
            || Phase == TEXT("health-panel")
            || Phase == TEXT("health-status")
            || Phase == TEXT("tool-pack-status")
            || Phase == TEXT("support-report-controls")
            || Phase == TEXT("support-report-refresh")
            || Phase == TEXT("support-report-generate")
            || Phase == TEXT("task-event")
            || Phase == TEXT("task-card")
            || Phase == TEXT("message-log")
            || Phase == TEXT("bridge")
            || Phase == TEXT("react")
            || Phase == TEXT("bridge-ready")
            || Phase == TEXT("tool-catalog")
            || Phase == TEXT("settling");
    }

    FString BuildBrowserTestScript(
        const FString& Nonce,
        const FString& CatalogMarker,
        const int32 ExpectedToolPackCount)
    {
        return FString::Printf(
            TEXT("(function(){")
            TEXT("var nonce='%s';")
            TEXT("var catalogMarker='%s';")
            TEXT("var expectedToolPackCount=%d;")
            TEXT("var passTitle='UEWEBUI_E2E_PASS';")
            TEXT("var failTitle='UEWEBUI_E2E_FAIL:';")
            TEXT("var waitTitle='UEWEBUI_E2E_WAIT:';")
            TEXT("if(window.__unrealEditorWebUIE2E&&window.__unrealEditorWebUIE2E.nonce===nonce){return;}")
            TEXT("var state={nonce:nonce,events:[],started:false,verifying:false,taskVerified:false,taskId:null,")
            TEXT("taskResponseJson:'',readySince:0,healthPanelOpened:false,initialReportRequested:false,")
            TEXT("initialReportText:'',postTaskReportRequested:false};")
            TEXT("window.__unrealEditorWebUIE2E=state;")
            TEXT("function phase(value){document.title=waitTitle+value;}")
            TEXT("phase('injected');")
            TEXT("function bridge(){return window.ue&&window.ue.editorwebui;}")
            TEXT("function fail(value){var reason=String(value&&value.message?value.message:value||'browser_assertion');")
            TEXT("var allowed=['browser_assertion','report_schema','support_report_redaction','report_identity',")
            TEXT("'overall_health','native_health','bridge_health','project_health','registry_health',")
            TEXT("'catalog_health','tool_pack_health','task_counts','completed_task_count','initial_task_count',")
            TEXT("'task_not_completed','missing_pong','nonce_mismatch','start_failed','unexpected_packaged_page'];")
            TEXT("document.title=failTitle+(allowed.indexOf(reason)!==-1?reason:'browser_assertion');}")
            TEXT("function record(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}")
            TEXT("function exactKeys(value,expected,label){")
            TEXT("if(!record(value)){throw new Error('report_schema');}")
            TEXT("var actual=Object.keys(value).sort().join(',');")
            TEXT("var wanted=expected.slice().sort().join(',');")
            TEXT("if(actual!==wanted){throw new Error('report_schema');}}")
            TEXT("function nonNegativeInteger(value){return Number.isInteger(value)&&value>=0;}")
            TEXT("function excluded(text,value,label){")
            TEXT("var needle=String(value||'');")
            TEXT("if(needle&&text.toLowerCase().indexOf(needle.toLowerCase())!==-1){")
            TEXT("throw new Error('support_report_redaction');}}")
            TEXT("function canonicalPluginVersion(value){")
            TEXT("return typeof value==='string'&&value.length>0&&value.length<=64")
            TEXT("&&/^[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/.test(value);}")
            TEXT("function canonicalEngineVersion(value){")
            TEXT("return typeof value==='string'&&value.length<=32")
            TEXT("&&/^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)$/.test(value);}")
            TEXT("function validateSupportReport(text,afterTask){")
            TEXT("var report=JSON.parse(text);")
            TEXT("exactKeys(report,['reportVersion','product','health','native','bridge','project','registry','catalog','toolPacks','tasks'],'report');")
            TEXT("if(report.reportVersion!==2||report.product!=='unreal-editor-webui'){throw new Error('report_identity');}")
            TEXT("exactKeys(report.health,['overallStatus','reasonCodes'],'health');")
            TEXT("if(report.health.overallStatus!=='healthy'||!Array.isArray(report.health.reasonCodes)")
            TEXT("||report.health.reasonCodes.length!==0){throw new Error('overall_health');}")
            TEXT("exactKeys(report.native,['protocolVersion','bridgeProtocolVersion','pluginVersion','engineVersion',")
            TEXT("'documentScope','pythonRuntime','privilegedConfirmation','taskSessionIsolation'],'native');")
            TEXT("if(report.native.protocolVersion!==1||report.native.bridgeProtocolVersion!==1")
            TEXT("||!canonicalPluginVersion(report.native.pluginVersion)")
            TEXT("||!canonicalEngineVersion(report.native.engineVersion)")
            TEXT("||report.native.documentScope!=='packaged'||report.native.pythonRuntime!=='available'")
            TEXT("||report.native.privilegedConfirmation!=='per_call'")
            TEXT("||report.native.taskSessionIsolation!=='document'){throw new Error('native_health');}")
            TEXT("exactKeys(report.bridge,['lifecycle','diagnosticCode'],'bridge');")
            TEXT("if(report.bridge.lifecycle!=='ready'||report.bridge.diagnosticCode!==null){throw new Error('bridge_health');}")
            TEXT("exactKeys(report.project,['persistence'],'project');")
            TEXT("if(report.project.persistence!=='enabled'){throw new Error('project_health');}")
            TEXT("exactKeys(report.registry,['status','availableCount','loadErrorCount'],'registry');")
            TEXT("if(report.registry.status!=='ready'||!nonNegativeInteger(report.registry.availableCount)")
            TEXT("||report.registry.availableCount<1||report.registry.loadErrorCount!==0){throw new Error('registry_health');}")
            TEXT("exactKeys(report.catalog,['status','source','schemaVersion','diagnosticCode'],'catalog');")
            TEXT("if(report.catalog.status!=='ready'||report.catalog.source!=='project'")
            TEXT("||report.catalog.schemaVersion!==1||report.catalog.diagnosticCode!==null){throw new Error('catalog_health');}")
            TEXT("exactKeys(report.toolPacks,['status','diagnosticCode','statusVersion','coreApiVersion',")
            TEXT("'loadedCount','rejectedCount','truncatedCount','reasonCodes'],'toolPacks');")
            TEXT("if(report.toolPacks.status!=='ready'||report.toolPacks.diagnosticCode!==null")
            TEXT("||report.toolPacks.statusVersion!==1||report.toolPacks.coreApiVersion!==1")
            TEXT("||report.toolPacks.loadedCount!==expectedToolPackCount||report.toolPacks.rejectedCount!==0")
            TEXT("||report.toolPacks.truncatedCount!==0||!Array.isArray(report.toolPacks.reasonCodes)")
            TEXT("||report.toolPacks.reasonCodes.length!==0){throw new Error('tool_pack_health');}")
            TEXT("exactKeys(report.tasks,['queued','running','completed','failed','cancelled','timedOut','total'],'tasks');")
            TEXT("var taskKeys=['queued','running','completed','failed','cancelled','timedOut'];")
            TEXT("if(!taskKeys.every(function(key){return nonNegativeInteger(report.tasks[key]);})")
            TEXT("||!nonNegativeInteger(report.tasks.total)")
            TEXT("||taskKeys.reduce(function(total,key){return total+report.tasks[key];},0)!==report.tasks.total){")
            TEXT("throw new Error('task_counts');}")
            TEXT("if(afterTask){if(report.tasks.completed<1||report.tasks.total<1){throw new Error('completed_task_count');}}")
            TEXT("else if(report.tasks.total!==0){throw new Error('initial_task_count');}")
            TEXT("excluded(text,catalogMarker,'catalog_marker');")
            TEXT("excluded(text,'HostProject','project_name');")
            TEXT("excluded(text,window.location.href,'page_url');")
            TEXT("excluded(text,window.location.pathname,'page_path');")
            TEXT("if(afterTask){")
            TEXT("excluded(text,nonce,'task_nonce');")
            TEXT("excluded(text,state.taskId,'task_id');")
            TEXT("excluded(text,state.taskResponseJson,'task_response');")
            TEXT("excluded(text,'cef-e2e','task_payload');")
            TEXT("excluded(text,'system.ping','task_command');")
            TEXT("excluded(text,'pong','task_result');}")
            TEXT("return report;")
            TEXT("}")
            TEXT("function healthPanel(){")
            TEXT("var toggle=document.querySelector('[data-health-panel-toggle]');")
            TEXT("if(!toggle){phase('health-toggle');return null;}")
            TEXT("if(!state.healthPanelOpened){toggle.click();state.healthPanelOpened=true;phase('health-panel');return null;}")
            TEXT("var panel=document.querySelector('[data-health-overall-status]');")
            TEXT("if(!panel){phase('health-panel');return null;}")
            TEXT("if(panel.getAttribute('data-health-overall-status')!=='healthy'){phase('health-status');return null;}")
            TEXT("return panel;")
            TEXT("}")
            TEXT("function supportReportText(panel,afterTask){")
            TEXT("var toolPacks=panel.querySelector('[data-tool-pack-status=\"ready\"]');")
            TEXT("if(!toolPacks){phase('tool-pack-status');return null;}")
            TEXT("var generate=panel.querySelector('[data-support-report-generate]');")
            TEXT("if(!generate){phase('support-report-controls');return null;}")
            TEXT("var requestKey=afterTask?'postTaskReportRequested':'initialReportRequested';")
            TEXT("if(!state[requestKey]){generate.click();state[requestKey]=true;")
            TEXT("phase(afterTask?'support-report-refresh':'support-report-generate');return null;}")
            TEXT("var preview=panel.querySelector('textarea[data-support-report-preview]');")
            TEXT("if(!preview){phase(afterTask?'support-report-refresh':'support-report-generate');return null;}")
            TEXT("var text=String(preview.value||'');")
            TEXT("if(afterTask&&text===state.initialReportText){generate.click();phase('support-report-refresh');return null;}")
            TEXT("if(!text){phase(afterTask?'support-report-refresh':'support-report-generate');return null;}")
            TEXT("return text;")
            TEXT("}")
            TEXT("function completedEvent(){return state.events.some(function(item){")
            TEXT("return item&&item.type==='task.status'&&item.taskId===state.taskId&&item.status==='completed';});}")
            TEXT("function reactBridgeReady(){")
            TEXT("return !!document.querySelector('[data-health-overall-status]');}")
            TEXT("function selected(element){return !!element&&(element.selected===true")
            TEXT("||element.classList.contains('active')||element.getAttribute('aria-selected')==='true'")
            TEXT("||element.getAttribute('aria-pressed')==='true');}")
            TEXT("function projectCatalogReady(){")
            TEXT("var root=document.querySelector('[data-tool-catalog-source=\"project\"][data-tool-catalog-schema-version=\"1\"]');")
            TEXT("if(!root){return false;}")
            TEXT("var project=root.querySelector('[data-tool-project-id=\"project-'+catalogMarker+'\"]');")
            TEXT("var stage=root.querySelector('[data-tool-stage-id=\"stage-'+catalogMarker+'\"]');")
            TEXT("var category=root.querySelector('[data-tool-category-id=\"category-'+catalogMarker+'\"]');")
            TEXT("return selected(project)&&selected(stage)&&selected(category);")
            TEXT("}")
            TEXT("function renderedCompletedEvent(){return Array.prototype.some.call(document.querySelectorAll('.log-panel'),function(panel){")
            TEXT("var heading=panel.querySelector('h2');return heading&&(heading.textContent||'').trim()==='Message Log'")
            TEXT("&&(panel.textContent||'').indexOf('task.status '+state.taskId+' completed')!==-1;});}")
            TEXT("async function verify(){")
            TEXT("if(!state.taskId||state.verifying){return;}")
            TEXT("if(!completedEvent()){phase('task-event');return;}")
            TEXT("state.verifying=true;")
            TEXT("try{")
            TEXT("if(!state.taskVerified){")
            TEXT("var rawTask=await bridge().gettask(state.taskId);")
            TEXT("var taskEnvelope=JSON.parse(rawTask);")
            TEXT("if(!taskEnvelope.ok||!taskEnvelope.result||taskEnvelope.result.status!=='completed'){throw new Error('task_not_completed');}")
            TEXT("state.taskResponseJson=String(taskEnvelope.result.responseJson||'');")
            TEXT("var executionEnvelope=JSON.parse(state.taskResponseJson||'{}');")
            TEXT("if(!executionEnvelope.ok||!executionEnvelope.result||executionEnvelope.result.message!=='pong'){throw new Error('missing_pong');}")
            TEXT("if(!executionEnvelope.result.echo||executionEnvelope.result.echo.nonce!==nonce){throw new Error('nonce_mismatch');}")
            TEXT("state.taskVerified=true;")
            TEXT("}")
            TEXT("var panel=healthPanel();")
            TEXT("if(!panel){state.verifying=false;return;}")
            TEXT("var refreshedReport=supportReportText(panel,true);")
            TEXT("if(!refreshedReport){state.verifying=false;return;}")
            TEXT("validateSupportReport(refreshedReport,true);")
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
            TEXT("if(!projectCatalogReady()){phase('tool-catalog');state.readySince=0;return;}")
            TEXT("var panel=healthPanel();")
            TEXT("if(!panel){state.readySince=0;return;}")
            TEXT("var initialReport=supportReportText(panel,false);")
            TEXT("if(!initialReport){state.readySince=0;return;}")
            TEXT("try{validateSupportReport(initialReport,false);state.initialReportText=initialReport;}")
            TEXT("catch(error){fail(error);return;}")
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
            *Nonce,
            *CatalogMarker,
            ExpectedToolPackCount);
    }

    class FUnrealEditorWebUIBrowserRoundTripCommand final : public IAutomationLatentCommand
    {
    public:
        FUnrealEditorWebUIBrowserRoundTripCommand(
            FAutomationTestBase* InTest,
            const FString& InCatalogMarker,
            const int32 InExpectedToolPackCount)
            : Test(InTest)
            , Nonce(FGuid::NewGuid().ToString(EGuidFormats::Digits))
            , CatalogMarker(InCatalogMarker)
            , ExpectedToolPackCount(InExpectedToolPackCount)
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
            const FString PassTitle = TEXT("UEWEBUI_E2E_PASS");
            const FString FailPrefix = TEXT("UEWEBUI_E2E_FAIL:");
            const FString WaitPrefix = TEXT("UEWEBUI_E2E_WAIT:");
            if (Title == PassTitle)
            {
                Test->AddInfo(TEXT("Packaged React page, healthy native/project/catalog/registry/Tool Pack product state, allowlisted support-report DOM, CEF JavaScript binding, system.ping task, aggregate-only refreshed task counts, DOM event log, and TaskCard round trip passed."));
                Tab->RequestCloseTab();
                return true;
            }
            if (Title.StartsWith(FailPrefix))
            {
                const FString CandidateReason = Title.Mid(FailPrefix.Len());
                const FString Reason = IsKnownBrowserFailureReason(CandidateReason)
                    ? CandidateReason
                    : FString(TEXT("browser_assertion"));
                Test->AddError(FString::Printf(TEXT("Browser round trip failed with reason code: %s"), *Reason));
                Tab->RequestCloseTab();
                return true;
            }

            if (Now - StartedAt >= BrowserTestTimeoutSeconds)
            {
                const FString CandidatePhase = Title.StartsWith(WaitPrefix)
                    ? Title.Mid(WaitPrefix.Len())
                    : FString();
                const FString Phase = IsKnownBrowserWaitPhase(CandidatePhase)
                    ? CandidatePhase
                    : FString(TEXT("unknown"));
                Test->AddError(FString::Printf(
                    TEXT("Timed out waiting for the CEF round trip. Loaded=%s phase=%s."),
                    BrowserWidget->IsLoaded() ? TEXT("true") : TEXT("false"),
                    *Phase));
                Tab->RequestCloseTab();
                return true;
            }

            if (Now - LastInjectionAt >= BrowserInjectionIntervalSeconds)
            {
                BrowserWidget->ExecuteJavascript(BuildBrowserTestScript(
                    Nonce,
                    CatalogMarker,
                    ExpectedToolPackCount));
                LastInjectionAt = Now;
            }

            return false;
        }

    private:
        FAutomationTestBase* Test;
        FString Nonce;
        FString CatalogMarker;
        int32 ExpectedToolPackCount;
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
    const FString CatalogMarker = FPlatformMisc::GetEnvironmentVariable(TEXT("UE_WEBUI_CATALOG_MARKER"));
    if (!IsValidCatalogMarker(CatalogMarker))
    {
        AddError(TEXT("UE_WEBUI_CATALOG_MARKER must be exactly 32 lowercase hexadecimal characters."));
        return false;
    }

    const FString ExpectedToolPackCountValue = FPlatformMisc::GetEnvironmentVariable(
        TEXT("UE_WEBUI_EXPECTED_TOOL_PACK_COUNT"));
    int32 ExpectedToolPackCount = 0;
    if (!TryParseExpectedToolPackCount(ExpectedToolPackCountValue, ExpectedToolPackCount))
    {
        AddError(TEXT(
            "UE_WEBUI_EXPECTED_TOOL_PACK_COUNT must be a canonical integer from 0 through 384."));
        return false;
    }

    ADD_LATENT_AUTOMATION_COMMAND(FUnrealEditorWebUIBrowserRoundTripCommand(
        this,
        CatalogMarker,
        ExpectedToolPackCount));
    return true;
}

#endif
