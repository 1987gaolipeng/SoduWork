; Stable GUI-subsystem entry point; no shortcut points at a removable version.
Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow
BrandingText "SoduWork"
SetFont "Microsoft YaHei UI" 9
Name "SoduWork"
Caption "SoduWork 正在更新"
OutFile "${SODUWORK_LAUNCHER_OUT}"
Icon "${SODUWORK_ICON}"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
${StrStr}
!define MUI_ICON "${SODUWORK_ICON}"
!include "MUI2.nsh"
!define MUI_INSTFILESPAGE_HEADER_TEXT "正在更新 SoduWork"
!define MUI_INSTFILESPAGE_HEADER_SUBTEXT "会话和文件会保留，完成后自动重新打开。"
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "准备完成"
!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "正在返回 SoduWork。"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Var target
Var arguments
Var count
Var pointer
Var exeName
Function .onInit
  ${GetParameters} $arguments
  ; NSIS must know it is non-silent before creating pages, not after Section starts.
  System::Call 'kernel32::CreateFileW(w "$EXEDIR\.soduwork-update.lock", i 0x80000000, i 7, p 0, i 3, i 0, p 0) p .r0'
  ${If} $0 == -1
    System::Call 'kernel32::GetLastError() i .r1'
    ${If} $1 == 32
      SetSilent normal
    ${EndIf}
  ${Else}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
FunctionEnd
Section
  StrCpy $count 0
  waitForInstall:
    ; Share violation means the installer owns the lock; a crash releases it.
    System::Call 'kernel32::CreateFileW(w "$EXEDIR\.soduwork-update.lock", i 0x80000000, i 7, p 0, i 3, i 0, p 0) p .r0'
    ${If} $0 == -1
      System::Call 'kernel32::GetLastError() i .r1'
      ${If} $1 == 32
        SetSilent normal
        ShowWindow $HWNDPARENT 5
        DetailPrint "正在准备新版本，请稍候。完成后会自动打开 SoduWork。"
        Sleep 250
        IntOp $count $count + 1
        ${If} $count < 2400
          Goto waitForInstall
        ${EndIf}
        MessageBox MB_OK|MB_ICONINFORMATION "SoduWork 仍在更新。请等待安装窗口完成后再打开，不需要重新下载。"
        Quit
      ${EndIf}
    ${Else}
      System::Call 'kernel32::CloseHandle(p r0)'
    ${EndIf}
  ${If} $arguments == "--soduwork-update-wait"
    SetErrorLevel 0
    Quit
  ${EndIf}
  StrCpy $pointer ".soduwork-active"
  readPointer:
  StrCpy $target ""
  ClearErrors
  FileOpen $0 "$EXEDIR\$pointer" r
  ${IfNot} ${Errors}
    FileRead $0 $target
    FileClose $0
  ${EndIf}
  ; Only one generated directory name, never a command or absolute path.
  ${StrStr} $1 $target "\"
  ${StrStr} $2 $target "/"
  ${StrStr} $3 $target ".."
  ${StrStr} $4 $target ":"
  ; The 1.12.52 launcher behavior under test is the lock-error lookup below.
  ; Payloads after the SoduWork rename ship SoduWork.exe, older ones SoduWork.exe;
  ; try both, newest name first, so the replica still opens either generation.
  StrCpy $exeName "SoduWork.exe"
  tryVersionedExe:
  ${If} $target != ""
  ${AndIf} $1 == ""
  ${AndIf} $2 == ""
  ${AndIf} $3 == ""
  ${AndIf} $4 == ""
  ${AndIf} ${FileExists} "$EXEDIR\.soduwork-versions\$target\.soduwork-release"
  ${AndIf} ${FileExists} "$EXEDIR\.soduwork-versions\$target\$exeName"
    SetOutPath "$EXEDIR\.soduwork-versions\$target"
    ClearErrors
    Exec '"$EXEDIR\.soduwork-versions\$target\$exeName" $arguments'
    ${IfNot} ${Errors}
      SetErrorLevel 0
      Quit
    ${EndIf}
  ${EndIf}
  ${If} $exeName == "SoduWork.exe"
    StrCpy $exeName "SoduWork.exe"
    Goto tryVersionedExe
  ${EndIf}
  ${If} $pointer == ".soduwork-active"
    StrCpy $pointer ".soduwork-previous"
    Goto readPointer
  ${EndIf}
  ; Interrupted first migration: original binary/resources have not been deleted.
  ${If} ${FileExists} "$EXEDIR\SoduWork.previous.exe"
    SetOutPath "$EXEDIR"
    ClearErrors
    Exec '"$EXEDIR\SoduWork.previous.exe" $arguments'
    ${IfNot} ${Errors}
      SetErrorLevel 0
      Quit
    ${EndIf}
  ${EndIf}
  MessageBox MB_OK|MB_ICONEXCLAMATION "SoduWork 安装尚未完成。请重新运行安装包修复；你的会话与文件不会被删除。"
  SetErrorLevel 2
SectionEnd
