[CmdletBinding()]
param([switch]$RestartPreviewHost)
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit PowerShell for this x64 registration.' }
$clsid = '{a8b4f9c2-6e75-4eaa-9a1d-e4276f01d937}'
$description = 'SimpleMD Markdown preview'
$class = "Software\Classes\CLSID\$clsid"
$extensions = @('.md', '.markdown', '.mdown', '.mkd', '.mdx')
$previewId = '{8895b1c6-b41f-4c1c-a562-0d564250836f}'
$handlers = 'Software\Microsoft\Windows\CurrentVersion\PreviewHandlers'
$statePath = 'Software\SimpleMD\Preview'
$root = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', 'Registry64')

function Get-LowRoot {
    if (-not ('SimpleMDPreview.KnownFolder' -as [type])) {
        Add-Type -Namespace SimpleMDPreview -Name KnownFolder -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll", PreserveSig = false)]
public static extern void SHGetKnownFolderPath(ref System.Guid id, uint flags, System.IntPtr token, out System.IntPtr path);
'@
    }
    $id = [Guid]'{a520a1a4-1780-4ff6-bd18-167343c5af16}'
    $path = [IntPtr]::Zero
    try {
        [SimpleMDPreview.KnownFolder]::SHGetKnownFolderPath([ref]$id, 0x4000, [IntPtr]::Zero, [ref]$path)
        return (Join-Path ([Runtime.InteropServices.Marshal]::PtrToStringUni($path)) 'SimpleMD\Preview')
    } finally { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($path) }
}

function Remove-EmptyKey($Path) {
    $key = $root.OpenSubKey($Path)
    if (-not $key) { return }
    try { $empty = ($key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0) } finally { $key.Dispose() }
    if ($empty) {
        $root.DeleteSubKey($Path, $false)
        Write-Host "Removed empty HKCU\$Path"
    }
}
function Remove-OwnedValue($Path, $Name, $Expected) {
    $key = $root.OpenSubKey($Path, $true)
    if (-not $key) { return }
    try {
        if ($key.GetValue($Name) -eq $Expected) {
            $key.DeleteValue($Name, $false)
            Write-Host "Removed HKCU\$Path [$Name]"
        } elseif ($key.GetValueNames() -contains $Name) {
            Write-Host "Kept changed HKCU\$Path [$Name]"
        }
    } finally { $key.Dispose() }
}

try {
    $state = $root.OpenSubKey($statePath)
    if (-not $state) { Write-Host 'No handler registration backup exists. No registry keys changed.'; return }
    try {
        $parentExisted = $state.GetValue('StateParentExisted')
        foreach ($extension in $extensions) {
            $association = "Software\Classes\$extension\shellex\$previewId"
            $key = $root.OpenSubKey($association, $true)
            if ($key) {
                try {
                    if ($key.GetValue('') -eq $clsid) {
                        if ($state.GetValue("$extension.Existed") -eq 1) {
                            $kind = [Microsoft.Win32.RegistryValueKind]($state.GetValue("$extension.Kind"))
                            $key.SetValue('', $state.GetValue("$extension.Value"), $kind)
                        } else { $key.DeleteValue('', $false) }
                    }
                } finally { $key.Dispose() }
            }
            foreach ($path in @($association, "Software\Classes\$extension\shellex", "Software\Classes\$extension")) {
                if ($state.GetValue($path) -eq 0) { Remove-EmptyKey $path }
            }
        }
        Remove-OwnedValue $handlers $clsid $description
        Remove-OwnedValue "$class\InprocServer32" '' ($state.GetValue('DllPath'))
        Remove-OwnedValue "$class\InprocServer32" 'ThreadingModel' 'Apartment'
        Remove-OwnedValue $class 'AppID' '{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}'
        Remove-OwnedValue $class '' $description
        Remove-EmptyKey "$class\InprocServer32"
        Remove-EmptyKey $class
        if ($state.GetValue($handlers) -eq 0) { Remove-EmptyKey $handlers }
    } finally { $state.Dispose() }
    $root.DeleteSubKeyTree($statePath, $false)
    if ($parentExisted -eq 0) { Remove-EmptyKey 'Software\SimpleMD' }
    Write-Host 'Removed the handler registration backup. No machine-wide keys changed.'
    if ($RestartPreviewHost) {
        Get-Process prevhost -ErrorAction SilentlyContinue | Where-Object SessionId -eq (Get-Process -Id $PID).SessionId | Stop-Process
        Write-Host 'Stopped preview hosts in this session. Explorer will start them again.'
    } else {
        Write-Host 'Optional: stop prevhost.exe in Task Manager to release the DLL, or use -RestartPreviewHost on uninstall.'
    }
    $lowRoot = Get-LowRoot
    $data = $lowRoot
    if (Test-Path -LiteralPath $data) {
        try {
            Remove-Item -LiteralPath $data -Recurse -Force
            Write-Host "Removed WebView2 data: $data"
        } catch { Write-Host "WebView2 still holds data files. After stopping prevhost.exe, remove: $data" }
    }

    Write-Host 'After saving the log and closing preview hosts, delete the extracted artifact folder.'
} finally { $root.Dispose() }
