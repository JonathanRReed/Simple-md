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
try {
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
} finally { $root.Dispose() }
