[CmdletBinding()]
param([switch]$RestartPreviewHost)
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit PowerShell for this x64 registration.' }
$clsid = '{a8b4f9c2-6e75-4eaa-9a1d-e4276f01d937}'
$description = 'SimpleMD Windows preview spike'
$class = "Software\Classes\CLSID\$clsid"
$association = 'Software\Classes\.md\shellex\{8895b1c6-b41f-4c1c-a562-0d564250836f}'
$handlers = 'Software\Microsoft\Windows\CurrentVersion\PreviewHandlers'
$statePath = 'Software\SimpleMD\PreviewSpike'
$root = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', 'Registry64')

function Get-LowRoot {
    if (-not ('SimpleMDPreviewSpike.KnownFolder' -as [type])) {
        Add-Type -Namespace SimpleMDPreviewSpike -Name KnownFolder -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll", PreserveSig = false)]
public static extern void SHGetKnownFolderPath(ref System.Guid id, uint flags, System.IntPtr token, out System.IntPtr path);
'@
    }
    $id = [Guid]'{a520a1a4-1780-4ff6-bd18-167343c5af16}'
    $path = [IntPtr]::Zero
    try {
        [SimpleMDPreviewSpike.KnownFolder]::SHGetKnownFolderPath([ref]$id, 0x4000, [IntPtr]::Zero, [ref]$path)
        return (Join-Path ([Runtime.InteropServices.Marshal]::PtrToStringUni($path)) 'SimpleMD\PreviewSpike')
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
    if (-not $state) { Write-Host 'No spike registration backup exists. No registry keys changed.'; return }
    try {
        $parentExisted = $state.GetValue('StateParentExisted')
        $key = $root.OpenSubKey($association, $true)
        if ($key) {
            try {
                $current = $key.GetValue('')
                if ($current -eq $clsid) {
                    if ($state.GetValue('PreviousValueExisted') -eq 1) {
                        $kind = [Microsoft.Win32.RegistryValueKind]($state.GetValue('PreviousKind'))
                        $key.SetValue('', $state.GetValue('PreviousValue'), $kind)
                        Write-Host 'Restored the previous per-user .md preview handler.'
                    } else {
                        $key.DeleteValue('', $false)
                        Write-Host 'Removed the spike .md preview association.'
                    }
                } else { Write-Host 'Kept the .md preview association changed after installation.' }
            } finally { $key.Dispose() }
        }
        Remove-OwnedValue $handlers $clsid $description
        Remove-OwnedValue "$class\InprocServer32" '' ($state.GetValue('DllPath'))
        Remove-OwnedValue "$class\InprocServer32" 'ThreadingModel' 'Apartment'
        Remove-OwnedValue $class 'AppID' '{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}'
        Remove-OwnedValue $class '' $description
        Remove-EmptyKey "$class\InprocServer32"
        Remove-EmptyKey $class
        foreach ($path in @($association, 'Software\Classes\.md\shellex', 'Software\Classes\.md', $handlers)) {
            if ($state.GetValue($path) -eq 0) { Remove-EmptyKey $path }
        }
    } finally { $state.Dispose() }
    $root.DeleteSubKeyTree($statePath, $false)
    if ($parentExisted -eq 0) { Remove-EmptyKey 'Software\SimpleMD' }
    Write-Host 'Removed the spike registration backup. No machine-wide keys changed.'
    if ($RestartPreviewHost) {
        Get-Process prevhost -ErrorAction SilentlyContinue | Where-Object SessionId -eq (Get-Process -Id $PID).SessionId | Stop-Process
        Write-Host 'Stopped preview hosts in this session. Explorer will start them again.'
    } else {
        Write-Host 'Optional: stop prevhost.exe in Task Manager to release the DLL, or use -RestartPreviewHost on uninstall.'
    }
    $lowRoot = Get-LowRoot
    $data = Join-Path $lowRoot 'UserData'
    if (Test-Path -LiteralPath $data) {
        try {
            Remove-Item -LiteralPath $data -Recurse -Force
            Write-Host "Removed WebView2 data: $data"
        } catch { Write-Host "WebView2 still holds data files. After stopping prevhost.exe, remove: $data" }
    }
    Write-Host "Kept the diagnostic log: $lowRoot\preview.log"
    Write-Host 'After saving the log and closing preview hosts, delete the extracted artifact folder.'
} finally { $root.Dispose() }
