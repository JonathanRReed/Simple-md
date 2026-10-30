# CI runner only. Installs and removes artifacts in the runner's disposable profile.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
$clsid = '{a8b4f9c2-6e75-4eaa-9a1d-e4276f01d937}'
$previewId = '{8895b1c6-b41f-4c1c-a562-0d564250836f}'
$extensions = @('.md', '.markdown', '.mdown', '.mkd', '.mdx')
$class = "HKEY_CURRENT_USER\Software\Classes\CLSID\$clsid"
$previous = '{00000000-0000-0000-0000-000000000001}'
$changed = '{00000000-0000-0000-0000-000000000002}'
$root = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', 'Registry64')
function Association($extension) { return "Software\Classes\$extension\shellex\$previewId" }
function Assert-Installed {
    foreach ($extension in $extensions) {
        $path = 'HKEY_CURRENT_USER\' + (Association $extension)
        if ([Microsoft.Win32.Registry]::GetValue($path, '', $null) -ne $clsid) { throw "Missing preview: $extension" }
    }
    if ([Microsoft.Win32.Registry]::GetValue("$class\InprocServer32", 'ThreadingModel', $null) -ne 'Apartment') { throw 'Missing STA registration' }
    $dll = [Microsoft.Win32.Registry]::GetValue("$class\InprocServer32", '', $null)
    if (-not (Test-Path -LiteralPath $dll)) { throw 'Registered DLL is absent' }
}
# The CI profile is disposable. A sentinel outside LocalLow must survive both
# entry points, including the installer runtime-check mode.
. (Join-Path $PSScriptRoot 'paths.ps1')
$low = Get-LowRoot
$outside = Join-Path $env:RUNNER_TEMP 'simplemd-preview-junction-target'
$dll = Join-Path $PSScriptRoot 'target/x86_64-pc-windows-msvc/release/simplemd_windows_preview.dll'
function Target-Snapshot {
    return (Get-ChildItem -LiteralPath $outside -Recurse -Force | ForEach-Object {
        "$($_.FullName)|$((Get-Acl -LiteralPath $_.FullName).Sddl)|$((Get-FileHash -LiteralPath $_.FullName).Hash)"
    }) -join "`n"
}
function Assert-Refused([string]$Script, [string[]]$ExtraArguments = @()) {
    $output = & "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PSScriptRoot/$Script" @ExtraArguments 2>&1
    if ($LASTEXITCODE -eq 0 -or ($output | Out-String) -notmatch 'reparse point') {
        throw "Expected reparse-point refusal from $Script, got: $output"
    }
}
try {
    New-Item -ItemType Directory -Path $outside -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $outside 'sentinel.txt') -Value 'must survive'
    Copy-Item -LiteralPath $dll -Destination $outside
    $before = Target-Snapshot
    foreach ($junction in @((Split-Path $low), $low)) {
        Assert-NoReparsePoint $low
        if (Test-Path -LiteralPath $low) { Remove-PreviewData $low }
        if ($junction -eq (Split-Path $low) -and (Test-Path -LiteralPath $junction)) {
            [IO.Directory]::Delete($junction)
        }
        New-Item -ItemType Directory -Path (Split-Path $junction) -Force | Out-Null
        New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
        try {
            Assert-Refused 'install.ps1' @('-DllPath', $dll, '-CheckRuntime')
            Assert-Refused 'uninstall.ps1'
            if ((Target-Snapshot) -ne $before) { throw 'Junction target changed' }
            if (Test-Path "Registry::$class") { throw 'Refused install changed registration' }
        } finally { [IO.Directory]::Delete($junction) }
    }
    # Runtime detection must never execute a caller-supplied DLL.
    New-Item -ItemType Directory -Path $low -Force | Out-Null
    $invalidDll = Join-Path $low 'not-code.dll'
    Set-Content -LiteralPath $invalidDll -Value 'not a PE image'
    $output = & "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PSScriptRoot/install.ps1" -DllPath $invalidDll -CheckRuntime 2>&1
    if ($LASTEXITCODE -notin @(0, 10)) { throw "Runtime detection attempted to load the DLL: $output" }
    # Refuse uninstall before touching the saved registration.
    $savedLow = "$low-saved"
    [IO.Directory]::Move($low, $savedLow)
    New-Item -ItemType Junction -Path $low -Target $outside | Out-Null
    try {
        Assert-Refused 'uninstall.ps1'
        if (-not (Test-Path "Registry::$class")) { throw 'Refused uninstall changed registration' }
        if ((Target-Snapshot) -ne $before) { throw 'Uninstall changed junction target' }
    } finally {
        [IO.Directory]::Delete($low)
        [IO.Directory]::Move($savedLow, $low)
    }
    # Nested links are removed as links without touching outside files or ACLs.
    New-Item -ItemType Junction -Path (Join-Path $low 'nested') -Target $outside | Out-Null
    & "$PSScriptRoot/uninstall.ps1"
    if ((Target-Snapshot) -ne $before) { throw 'Nested junction target changed' }
    if (Test-Path -LiteralPath $low) { throw 'Nested-link cleanup did not remove preview data' }

    # Standalone scripts preserve previous associations, survive reinstall and keep later changes.
    foreach ($extension in $extensions) {
        $key = $root.CreateSubKey((Association $extension))
        $key.SetValue('', $previous)
        $key.Dispose()
    }
    & "$PSScriptRoot/install.ps1" -DllPath "$PSScriptRoot/target/x86_64-pc-windows-msvc/release/simplemd_windows_preview.dll"
    Assert-Installed
    & "$PSScriptRoot/install.ps1" -DllPath "$PSScriptRoot/target/x86_64-pc-windows-msvc/release/simplemd_windows_preview.dll"
    Assert-Installed
    $key = $root.OpenSubKey((Association '.mdx'), $true)
    $key.SetValue('', $changed)
    $key.Dispose()
    & "$PSScriptRoot/uninstall.ps1"
    foreach ($extension in $extensions) {
        $expected = if ($extension -eq '.mdx') { $changed } else { $previous }
        $path = 'HKEY_CURRENT_USER\' + (Association $extension)
        if ([Microsoft.Win32.Registry]::GetValue($path, '', $null) -ne $expected) { throw "Lost previous/changed association: $extension" }
    }
    if (Test-Path "Registry::$class") { throw 'Standalone CLSID survived uninstall' }

    # Real NSIS package, including Open With and the installed PowerShell hooks.
    $install = Join-Path $env:RUNNER_TEMP 'simplemd-m7'
    $process = Start-Process -FilePath (Resolve-Path -LiteralPath $Installer) -ArgumentList @('/S', '/currentuser', "/D=$install") -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer exit $($process.ExitCode)" }
    try {
        $hookLog = Join-Path $env:TEMP 'SimpleMD-preview-install.log'
        if (Test-Path -LiteralPath $hookLog) { Get-Content -LiteralPath $hookLog | Write-Host }
        Assert-Installed
        foreach ($extension in $extensions) {
            $key = $root.OpenSubKey("Software\Classes\$extension\OpenWithProgids")
            if (-not $key -or $key.GetValueNames() -notcontains 'Markdown document') { throw "Missing Open With: $extension" }
            $key.Dispose()
        }
        $command = [Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\Software\Classes\Markdown document\shell\open\command', '', '')
        if (-not $command.Contains("$install\SimpleMD.exe")) { throw 'Open With points outside the installation' }
        # Install and uninstaller must not run the app.
        if (Get-Process SimpleMD -ErrorAction SilentlyContinue) { throw 'Installer launched SimpleMD' }
    } finally {
        $uninstaller = Join-Path $install 'Uninstall SimpleMD.exe'
        $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser', "_?=$install") -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "Uninstaller exit $($process.ExitCode)" }
    }
    foreach ($extension in $extensions) {
        $expected = if ($extension -eq '.mdx') { $changed } else { $previous }
        $path = 'HKEY_CURRENT_USER\' + (Association $extension)
        if ([Microsoft.Win32.Registry]::GetValue($path, '', $null) -ne $expected) { throw "NSIS failed to restore: $extension" }
    }
    if (Test-Path "Registry::$class") { throw 'NSIS CLSID survived uninstall' }
    if (Test-Path 'HKCU:\Software\SimpleMD\Preview') { throw 'Registration backup survived uninstall' }
    # Resolve redirected LocalLow through the same known-folder API as the handler.
    $id = [Guid]'{a520a1a4-1780-4ff6-bd18-167343c5af16}'
    $pointer = [IntPtr]::Zero
    [SimpleMDPreview.KnownFolder]::SHGetKnownFolderPath([ref]$id, 0, [IntPtr]::Zero, [ref]$pointer)
    try { $low = Join-Path ([Runtime.InteropServices.Marshal]::PtrToStringUni($pointer)) 'SimpleMD\Preview' }
    finally { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($pointer) }
    if (Test-Path -LiteralPath $low) { throw "Preview data survived uninstall: $low" }
    Remove-Item -LiteralPath $install -Recurse -Force -ErrorAction SilentlyContinue
} finally {
    $root.Dispose()
    if (Test-Path -LiteralPath $outside) { Remove-Item -LiteralPath $outside -Recurse -Force }
}
