; Display-only metadata shared by the installer and its native observer.
; Never use this file to authorize activation, cleanup, or application launch.
Var installContextRoot
Var installFromVersion
Var installToVersion
Var installOperation

; $0 in/out. Bound text to a single token, also safe as a directory name.
; Deliberately do not interpret it as a command or compare prerelease precedence.
Function ValidateInstallToken
  Push $1
  Push $2
  Push $3
  StrLen $1 $0
  ${If} $1 == 0
  ${OrIf} $1 > 48
    StrCpy $0 ""
    Goto versionValidated
  ${EndIf}
  StrCpy $1 0
  versionCharacter:
    StrCpy $2 $0 1 $1
    ${If} $2 == ""
      Goto versionValidated
    ${EndIf}
    ; StrSpnW avoids adding installer-wide StrFunc instances.
    System::Call 'shlwapi::StrSpnW(w r2, w "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.+-_") i .r3'
    ${If} $3 != 1
      StrCpy $0 ""
      Goto versionValidated
    ${EndIf}
    IntOp $1 $1 + 1
    Goto versionCharacter
  versionValidated:
  Pop $3
  Pop $2
  Pop $1
FunctionEnd

; A display version must have a numeric major.minor.patch core. Unknown legacy
; labels are not versions; prerelease/build suffixes remain literal display text.
Function ValidateInstallVersion
  Call ValidateInstallToken
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $1 0
  StrCpy $2 $0
  ${Do}
    System::Call 'shlwapi::StrSpnW(w r2, w "0123456789") i .r3'
    ${If} $3 == 0
      StrCpy $0 ""
      ${Break}
    ${EndIf}
    StrCpy $2 $2 "" $3
    StrCpy $4 $2 1
    IntOp $1 $1 + 1
    ${If} $1 == 3
      ${If} $2 != ""
        StrLen $3 $2
        ${If} $3 < 2
          StrCpy $0 ""
        ${ElseIf} $4 != "-"
        ${AndIf} $4 != "+"
          StrCpy $0 ""
        ${EndIf}
      ${EndIf}
      ${Break}
    ${EndIf}
    ${If} $4 != "."
      StrCpy $0 ""
      ${Break}
    ${EndIf}
    StrCpy $2 $2 "" 1
  ${Loop}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
FunctionEnd

!ifdef SODUWORK_INSTALL_CONTEXT_WRITER
Function WriteInstallContext
  StrCpy $installFromVersion ""
  ; Only consult a committed payload in this installation. A leftover launcher,
  ; --updated, or /S alone does not prove that an older version is installed.
  StrCpy $4 ".soduwork-active"
  readInstalledVersion:
    StrCpy $0 ""
    ClearErrors
    FileOpen $1 "$installContextRoot\$4" r
    ${IfNot} ${Errors}
      FileRead $1 $0
      FileClose $1
    ${EndIf}
    Call ValidateInstallToken
    ; Generated stage names may contain dots, but never parent traversal.
    ${If} $0 == "."
    ${OrIf} $0 == ".."
      StrCpy $0 ""
    ${EndIf}
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$installContextRoot\.soduwork-versions\$0\${APP_EXECUTABLE_FILENAME}"
      StrCpy $2 "$installContextRoot\.soduwork-versions\$0\.soduwork-release"
      StrCpy $0 ""
      ClearErrors
      FileOpen $1 "$2" r
      ${IfNot} ${Errors}
        FileRead $1 $0
        FileClose $1
      ${EndIf}
      Call ValidateInstallVersion
      StrCpy $installFromVersion $0
    ${EndIf}
    ${If} $installFromVersion == ""
    ${AndIf} $4 == ".soduwork-active"
      StrCpy $4 ".soduwork-previous"
      Goto readInstalledVersion
    ${EndIf}
  ; Old flat installations without a version marker stay neutral/unknown.
  ${If} $installFromVersion == ""
  ${AndIfNot} ${FileExists} "$installContextRoot\.soduwork-launcher"
  ${AndIf} ${FileExists} "$installContextRoot\${APP_EXECUTABLE_FILENAME}"
    StrCpy $0 ""
    ClearErrors
    FileOpen $1 "$installContextRoot\.soduwork-release" r
    ${IfNot} ${Errors}
      FileRead $1 $0
      FileClose $1
    ${EndIf}
    Call ValidateInstallVersion
    StrCpy $installFromVersion $0
  ${EndIf}
  StrCpy $0 "${VERSION}"
  Call ValidateInstallVersion
  StrCpy $installToVersion $0
  ; Clear stale display data even if this attempt cannot publish new metadata.
  Delete "$installContextRoot\.soduwork-install-context.ini"
  Delete "$installContextRoot\.soduwork-install-context.ini.next"
  ClearErrors
  WriteINIStr "$installContextRoot\.soduwork-install-context.ini.next" "install" "schema" "1"
  WriteINIStr "$installContextRoot\.soduwork-install-context.ini.next" "install" "from" "$installFromVersion"
  WriteINIStr "$installContextRoot\.soduwork-install-context.ini.next" "install" "to" "$installToVersion"
  ${IfNot} ${Errors}
    System::Call 'kernel32::MoveFileExW(w "$installContextRoot\.soduwork-install-context.ini.next", w "$installContextRoot\.soduwork-install-context.ini", i 9) i .r0'
  ${EndIf}
  Delete "$installContextRoot\.soduwork-install-context.ini.next"
FunctionEnd
!else
Function ReadInstallContext
  StrCpy $installOperation "install"
  StrCpy $installFromVersion ""
  StrCpy $installToVersion ""
  ReadINIStr $0 "$installContextRoot\.soduwork-install-context.ini" "install" "schema"
  ${If} $0 != "1"
    Return
  ${EndIf}
  ReadINIStr $0 "$installContextRoot\.soduwork-install-context.ini" "install" "to"
  Call ValidateInstallVersion
  StrCpy $installToVersion $0
  ${If} $installToVersion == ""
    Return
  ${EndIf}
  ReadINIStr $0 "$installContextRoot\.soduwork-install-context.ini" "install" "from"
  Call ValidateInstallVersion
  StrCpy $installFromVersion $0
  ${If} $installFromVersion != ""
    StrCpy $installOperation "update"
    ${If} $installFromVersion == $installToVersion
      StrCpy $installOperation "reinstall"
    ${EndIf}
  ${EndIf}
FunctionEnd
!endif
