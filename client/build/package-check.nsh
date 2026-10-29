; Self-check accepts only a UUID, never a destination path. The installer chooses
; a new directory under TEMP and exits before ordinary installation initialization.
; Any malformed/quoted diagnostic argument must fail closed, not start installation.
Var soduworkCheckRoot
!macro preInit
  ${GetParameters} $R8
  Push $R8
  System::Call 'shlwapi::StrStrIW(w s, w "SODUWORK-PACKAGE-CHECK") p .r0'
  ${If} $0 != 0
    ClearErrors
    ${GetOptions} $R8 "/SODUWORK-PACKAGE-CHECK=" $soduworkCheckRoot
    ${If} ${Errors}
      SetErrorLevel 87
      Quit
    ${EndIf}
    StrLen $R7 $soduworkCheckRoot
    ${If} $R7 != 36
      SetErrorLevel 87
      Quit
    ${EndIf}
    System::Alloc 16
    Pop $R9
    ${If} $R9 == 0
      SetErrorLevel 8
      Quit
    ${EndIf}
    Push "{$soduworkCheckRoot}"
    System::Call 'ole32::CLSIDFromString(w s, p $R9) i .r0'
    System::Free $R9
    ${If} $0 != 0
      SetErrorLevel 87
      Quit
    ${EndIf}
    StrCpy $soduworkCheckRoot "$TEMP\soduwork-package-check-$soduworkCheckRoot"
    System::Call 'kernel32::GetFileAttributesW(w "$soduworkCheckRoot") i .r0'
    ${If} $0 != -1
      SetErrorLevel 183
      Quit
    ${EndIf}
    ClearErrors
    !insertmacro soduWorkExtractPayload "$soduworkCheckRoot"
    ${If} ${Errors}
      SetErrorLevel 2
      Quit
    ${EndIf}
    System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "1")'
    nsExec::ExecToStack '"$soduworkCheckRoot\${APP_EXECUTABLE_FILENAME}" "$soduworkCheckRoot\.soduwork-verify.cjs" "$soduworkCheckRoot" "$soduworkCheckRoot\.soduwork-update-details.json"'
    Pop $0
    Pop $1
    SetErrorLevel $0
    Quit
  ${EndIf}
!macroend