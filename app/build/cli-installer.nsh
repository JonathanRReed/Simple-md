!include "StrFunc.nsh"
${StrStr}
${UnStrStr}
${UnStrRep}

!macro customInstall
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
