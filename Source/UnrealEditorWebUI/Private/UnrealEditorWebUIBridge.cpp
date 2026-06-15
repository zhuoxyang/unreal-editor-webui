#include "UnrealEditorWebUIBridge.h"

#include "IPythonScriptPlugin.h"
#include "Misc/App.h"
#include "Misc/Paths.h"

DEFINE_LOG_CATEGORY_STATIC(LogUnrealEditorWebUIBridge, Log, All);

void UUnrealEditorWebUIBridge::PostMessage(const FString& Payload)
{
    UE_LOG(LogUnrealEditorWebUIBridge, Log, TEXT("WebUI message: %s"), *Payload);
}

FString UUnrealEditorWebUIBridge::GetProjectName() const
{
    return FApp::GetProjectName();
}

FString UUnrealEditorWebUIBridge::GetProjectDir() const
{
    return FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
}

bool UUnrealEditorWebUIBridge::ExecutePython(const FString& PythonCode)
{
    if (PythonCode.IsEmpty())
    {
        UE_LOG(LogUnrealEditorWebUIBridge, Warning, TEXT("Ignored empty Python command from WebUI."));
        return false;
    }

    return IPythonScriptPlugin::Get()->ExecPythonCommand(*PythonCode);
}
