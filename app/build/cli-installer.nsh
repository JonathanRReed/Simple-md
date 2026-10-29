!include "StrFunc.nsh"
!ifdef BUILD_UNINSTALLER
  ${UnStrStr}
  ${UnStrRep}
!else
  ${StrStr}
!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInit
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
!macroend

!macro customInstall
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\native\preview\install.ps1" -CheckRuntime'
  Pop $0
  ${If} $0 == 10
    IfSilent previewRuntimeDone
    MessageBox MB_YESNO|MB_ICONQUESTION "Install the Microsoft Evergreen WebView2 runtime for formatted previews? Source previews work without it." IDNO previewRuntimeDone
    ExecShell "open" "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
    previewRuntimeDone:
  ${ElseIf} $0 != 0
    DetailPrint "Preview registration failed ($0). Run resources\native\preview\install.ps1 to retry."
  ${EndIf}
  WriteRegStr HKCU "Software\Classes\simplemd" "" "URL:SimpleMD"
  WriteRegStr HKCU "Software\Classes\simplemd" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\simplemd\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" -- $\"%1$\"'
  ReadRegStr $0 HKCU "Environment" "Path"
  ${StrStr} $1 ";$0;" ";$INSTDIR\resources\native;"
  ${If} $1 == ""
    ${If} $0 == ""
      StrCpy $0 "$INSTDIR\resources\native"
    ${Else}
      StrCpy $0 "$0;$INSTDIR\resources\native"
    ${EndIf}
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\native\preview\uninstall.ps1" -RestartPreviewHost'
  Pop $0
  ReadRegStr $0 HKCU "Environment" "Path"
  ${UnStrRep} $0 ";$0;" ";$INSTDIR\resources\native;" ";"
  StrCpy $0 $0 "" 1
  StrCpy $0 $0 -1
  WriteRegExpandStr HKCU "Environment" "Path" "$0"
  ReadRegStr $1 HKCU "Software\Classes\simplemd\shell\open\command" ""
  ${UnStrStr} $2 "$1" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" -- '
  ${If} $2 != ""
    DeleteRegKey HKCU "Software\Classes\simplemd"
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
