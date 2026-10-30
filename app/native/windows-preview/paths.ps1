# Shared by the HKCU install and uninstall entry points.
function Test-X64Windows {
    if (-not ('SimpleMDPreview.Architecture' -as [type])) {
        Add-Type -Namespace SimpleMDPreview -Name Architecture -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
[return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
public static extern bool IsWow64Process2(System.IntPtr process, out ushort processMachine, out ushort nativeMachine);
'@
    }
    [ushort]$processMachine = 0
    [ushort]$nativeMachine = 0
    if (-not [SimpleMDPreview.Architecture]::IsWow64Process2(
        (Get-Process -Id $PID).Handle, [ref]$processMachine, [ref]$nativeMachine)) {
        throw 'Could not determine the native Windows architecture. No preview registration changed.'
    }
    if ($nativeMachine -ne 0x8664) {
        Write-Host 'Skipping SimpleMD preview registration: the preview DLL requires native x64 Windows.'
        return $false
    }
    return $true
}

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

function Assert-NoReparsePoint([string]$Path) {
    # Check every existing component, including redirected known-folder ancestors.
    # GetAttributes also catches dangling junctions. Do not use Test-Path, which
    # treats some inaccessible or dangling paths as absent.
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        try {
            $attributes = [IO.File]::GetAttributes($current)
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing preview setup or removal through a reparse point: $current"
            }
        } catch [IO.FileNotFoundException] {
        } catch [IO.DirectoryNotFoundException] {
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Remove-PreviewData([string]$Path) {
    Assert-NoReparsePoint $Path
    if ([IO.Directory]::Exists($Path)) {
        # cmd rd removes nested junctions as links, without traversing their targets.
        # Invoke the system cmd directly, with the known-folder path quoted.
        & "$env:SystemRoot\System32\cmd.exe" /d /c "rd /s /q `"$Path`""
        if ($LASTEXITCODE -ne 0) { throw "Could not remove preview data: $Path" }
    }
}

function Test-WebView2Runtime {
    # Microsoft's documented Evergreen detection. Read versions only; never load
    # the preview DLL (or any code from the caller-supplied path) in this process.
    $client = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($hive in @('CurrentUser', 'LocalMachine')) {
        foreach ($view in @('Registry32', 'Registry64')) {
            $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            try {
                $key = $registry.OpenSubKey($client)
                if ($key) {
                    try {
                        $version = $null
                        if ([Version]::TryParse([string]$key.GetValue('pv'), [ref]$version) -and
                            $version -gt [Version]'0.0.0.0') { return $true }
                    } finally { $key.Dispose() }
                }
            } finally { $registry.Dispose() }
        }
    }
    return $false
}
