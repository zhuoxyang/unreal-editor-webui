param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -cne "Windows_NT") {
    throw "The protected UE runner requires Windows."
}

if ($null -eq ("UnrealEditorWebUI.NativeInteractiveDesktop" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace UnrealEditorWebUI
{
    public static class NativeInteractiveDesktop
    {
        [DllImport("kernel32.dll")]
        public static extern uint WTSGetActiveConsoleSessionId();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr OpenInputDesktop(
            uint dwFlags,
            bool fInherit,
            uint dwDesiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseDesktop(IntPtr hDesktop);
    }
}
"@
}

$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if ($null -eq $Identity.User) {
    throw "The runner process has no Windows user SID."
}

$ServiceSids = @(
    [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
    [System.Security.Principal.WellKnownSidType]::LocalServiceSid,
    [System.Security.Principal.WellKnownSidType]::NetworkServiceSid
)
foreach ($ServiceSid in $ServiceSids) {
    if ($Identity.User.IsWellKnown($ServiceSid)) {
        throw "A Windows service identity cannot host protected GUI validation."
    }
}

$AdministratorsSid = "S-1-5-32-544"
$AdministratorMembership = @(
    $Identity.Groups |
        Where-Object { $_.Value -ceq $AdministratorsSid }
)
if ($AdministratorMembership.Count -ne 0) {
    throw "The protected UE runner must use a dedicated standard Windows account, not an administrator account."
}

if (-not [Environment]::UserInteractive) {
    throw "The protected UE runner process is not attached to an interactive window station."
}

$CurrentSessionId = (Get-Process -Id $PID).SessionId
$ActiveConsoleSessionId = [UnrealEditorWebUI.NativeInteractiveDesktop]::WTSGetActiveConsoleSessionId()
if ($CurrentSessionId -eq 0 -or
    $ActiveConsoleSessionId -eq [uint32]::MaxValue -or
    [uint32]$CurrentSessionId -ne $ActiveConsoleSessionId) {
    throw "The protected UE runner must execute in the active nonzero console session."
}

$DesktopReadObjects = [uint32]0x0001
$DesktopSwitchDesktop = [uint32]0x0100
$InputDesktop = [UnrealEditorWebUI.NativeInteractiveDesktop]::OpenInputDesktop(
    0,
    $false,
    ($DesktopReadObjects -bor $DesktopSwitchDesktop)
)
if ($InputDesktop -eq [IntPtr]::Zero) {
    throw "The protected UE runner cannot open the active input desktop."
}
try {
    $SessionExplorer = @(
        Get-Process -Name explorer -ErrorAction SilentlyContinue |
            Where-Object { $_.SessionId -eq $CurrentSessionId }
    )
    if ($SessionExplorer.Count -eq 0) {
        throw "The protected UE runner session has no interactive Explorer desktop."
    }
}
finally {
    if (-not [UnrealEditorWebUI.NativeInteractiveDesktop]::CloseDesktop($InputDesktop)) {
        throw "The protected UE runner could not close its input-desktop validation handle."
    }
}

$ProfilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$DocumentsPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
if ([string]::IsNullOrWhiteSpace($ProfilePath) -or
    [string]::IsNullOrWhiteSpace($DocumentsPath) -or
    -not (Test-Path -LiteralPath $ProfilePath -PathType Container)) {
    throw "The protected UE runner requires a loaded dedicated Windows user profile."
}

[ordered]@{
    schemaVersion = 1
    windows = $true
    standardUser = $true
    interactive = $true
    activeConsole = $true
    inputDesktop = $true
    explorerDesktop = $true
    profileLoaded = $true
} | ConvertTo-Json -Compress
