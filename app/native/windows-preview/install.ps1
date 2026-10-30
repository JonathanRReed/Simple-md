# Run in a normal 64-bit PowerShell session, not as administrator.
[CmdletBinding()]
param(
    [string]$DllPath,
    [switch]$RestartPreviewHost,
    [switch]$CheckRuntime
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'paths.ps1')
if (-not (Test-X64Windows)) { return }
# Refuse before any registration, removal, directory creation or host restart.
$lowRoot = Get-LowRoot
Assert-NoReparsePoint $lowRoot
if (-not $DllPath) { $DllPath = Join-Path $PSScriptRoot 'simplemd_windows_preview.dll' }
if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit PowerShell for this x64 DLL.' }
$DllPath = (Resolve-Path -LiteralPath $DllPath).Path
$clsid = '{a8b4f9c2-6e75-4eaa-9a1d-e4276f01d937}'
$description = 'SimpleMD Markdown preview'
$class = "Software\Classes\CLSID\$clsid"
$extensions = @('.md', '.markdown', '.mdown', '.mkd', '.mdx')
$previewId = '{8895b1c6-b41f-4c1c-a562-0d564250836f}'
$handlers = 'Software\Microsoft\Windows\CurrentVersion\PreviewHandlers'
$statePath = 'Software\SimpleMD\Preview'
$root = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', 'Registry64')

function Set-String($Path, $Name, $Value) {
    $key = $root.CreateSubKey($Path)
    try { $key.SetValue($Name, $Value, 'String') } finally { $key.Dispose() }
    Write-Host "Set HKCU\$Path [$Name] = $Value"
}

try {
    $state = $root.OpenSubKey($statePath)
    if ($state) {
        $state.Dispose()
        & (Join-Path $PSScriptRoot 'uninstall.ps1')
    }
    $key = $root.OpenSubKey($class)
    if ($key) { $key.Dispose(); throw "Refusing to overwrite HKCU\$class" }
    $key = $root.OpenSubKey($handlers)
    if ($key) {
        try {
            if ($key.GetValueNames() -contains $clsid) { throw 'The handler PreviewHandlers value already exists without a backup.' }
        } finally { $key.Dispose() }
    }
    # Resolve the same known folder as the DLL before writing registration.
    New-Item -ItemType Directory -Path $lowRoot -Force | Out-Null
    Assert-NoReparsePoint $lowRoot
    # LocalLow already supplies the inherited low-integrity label.
    Write-Host "Prepared low-integrity log and data directory: $lowRoot"

    $parent = $root.OpenSubKey('Software\SimpleMD')
    $parentExisted = [int]($null -ne $parent)
    if ($parent) { $parent.Dispose() }
    $state = $root.CreateSubKey($statePath)
    try {
        $state.SetValue('StateParentExisted', $parentExisted, 'DWord')
        $state.SetValue('DllPath', $DllPath, 'String')
        foreach ($extension in $extensions) {
            $association = "Software\Classes\$extension\shellex\$previewId"
            $key = $root.OpenSubKey($association)
            try {
                $exists = $key -and ($key.GetValueNames() -contains '')
                $state.SetValue("$extension.Existed", [int][bool]$exists, 'DWord')
                if ($exists) {
                    $kind = $key.GetValueKind('').ToString()
                    if ($kind -notin @('String', 'ExpandString')) { throw "Invalid preview value for $extension" }
                    $state.SetValue("$extension.Value", $key.GetValue('', $null, 'DoNotExpandEnvironmentNames'), 'String')
                    $state.SetValue("$extension.Kind", $kind, 'String')
                }
            } finally { if ($key) { $key.Dispose() } }
            foreach ($path in @($association, "Software\Classes\$extension\shellex", "Software\Classes\$extension")) {
                $key = $root.OpenSubKey($path)
                $state.SetValue($path, [int]($null -ne $key), 'DWord')
                if ($key) { $key.Dispose() }
            }
        }
        $key = $root.OpenSubKey($handlers)
        $state.SetValue($handlers, [int]($null -ne $key), 'DWord')
        if ($key) { $key.Dispose() }
    } finally { $state.Dispose() }
    try {
        Set-String $class '' $description
        Set-String $class 'AppID' '{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}'
        Set-String "$class\InprocServer32" '' $DllPath
        Set-String "$class\InprocServer32" 'ThreadingModel' 'Apartment'
        Set-String $handlers $clsid $description
        foreach ($extension in $extensions) { Set-String "Software\Classes\$extension\shellex\$previewId" '' $clsid }
    } catch {
        Write-Host 'Registration failed. Restoring saved values.'
        & (Join-Path $PSScriptRoot 'uninstall.ps1')
        throw
    }
    Write-Host 'Registered Markdown extensions in HKCU. The default Open With application is unchanged.'
    Write-Host "Log: $lowRoot\preview.log"
    if ($CheckRuntime) {
        if (-not (Test-WebView2Runtime)) {
            Write-Host 'Evergreen WebView2 is missing. Native source preview is available.'
            exit 10
        }
    }
    if ($RestartPreviewHost) {
        Get-Process prevhost -ErrorAction SilentlyContinue | Where-Object SessionId -eq (Get-Process -Id $PID).SessionId | Stop-Process
        Write-Host 'Stopped preview hosts in this session. Explorer will start them again.'
    } else {
        Write-Host 'Optional: stop prevhost.exe in Task Manager, or use -RestartPreviewHost on install or uninstall.'
    }
} finally { $root.Dispose() }
