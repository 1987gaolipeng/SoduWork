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
Var updateRoot
Var updatePhase
Function .onInit
  ${GetParameters} $arguments
  StrCpy $updateRoot "$EXEDIR"
  ${If} $arguments == "--soduwork-update-wait"
    ReadEnvStr $0 "SODUWORK_UPDATE_ROOT"
    ${If} $0 != ""
      StrCpy $updateRoot "$0"
    ${EndIf}
  ${EndIf}
  ; NSIS must know it is non-silent before creating pages, not after Section starts.
  ; Capture last error in the same native call; a later plugin call can overwrite it.
  System::Call 'kernel32::CreateFileW(w "$updateRoot\.soduwork-update.lock", i 0x80000000, i 7, p 0, i 3, i 0, p 0) p .r0 ?e'
  Pop $1
  ${If} $0 == -1
    ${If} $1 == 32
      SetSilent normal
    ${EndIf}
  ${Else}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
FunctionEnd
Function ShowUpdatePhase
  ; Unknown duration: an indeterminate bar never claims the install is 100%.
  System::Call 'user32::GetWindowLongW(p $mui.InstFilesPage.ProgressBar, i -16) i .r0'
  IntOp $0 $0 | 0x08
  System::Call 'user32::SetWindowLongW(p $mui.InstFilesPage.ProgressBar, i -16, i r0)'
  SendMessage $mui.InstFilesPage.ProgressBar 0x040A 1 30
  StrCpy $1 ""
  ClearErrors
  FileOpen $0 "$updateRoot\.soduwork-update-phase" r
  ${IfNot} ${Errors}
    FileRead $0 $1
    FileClose $0
  ${EndIf}
  ${If} $1 == $updatePhase
    Return
  ${EndIf}
  ${If} $1 == "extracting"
    !insertmacro MUI_HEADER_TEXT "正在准备新版本文件" "正在解包，旧版本与工作数据仍然保留。"
  ${ElseIf} $1 == "verifying"
    !insertmacro MUI_HEADER_TEXT "正在校验更新文件" "正在确认文件完整性，校验通过后才会切换版本。"
  ${ElseIf} $1 == "activating"
    !insertmacro MUI_HEADER_TEXT "正在切换到新版本" "校验已通过，正在完成安装。"
  ${ElseIf} $1 == "committed"
    !insertmacro MUI_HEADER_TEXT "新版本已准备好" "正在完成收尾，随后自动重新打开 SoduWork。"
  ${Else}
    Return
  ${EndIf}
  StrCpy $updatePhase "$1"
FunctionEnd
Section
  StrCpy $count 0
  waitForInstall:
    ; Share violation means the installer owns the lock; a crash releases it.
    System::Call 'kernel32::CreateFileW(w "$updateRoot\.soduwork-update.lock", i 0x80000000, i 7, p 0, i 3, i 0, p 0) p .r0 ?e'
    Pop $1
    ${If} $0 == -1
      ${If} $1 == 32
        SetSilent normal
        ShowWindow $HWNDPARENT 5
        Call ShowUpdatePhase
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
  ${If} $target != ""
  ${AndIf} $1 == ""
  ${AndIf} $2 == ""
  ${AndIf} $3 == ""
  ${AndIf} $4 == ""
  ${AndIf} ${FileExists} "$EXEDIR\.soduwork-versions\$target\.soduwork-release"
  ${AndIf} ${FileExists} "$EXEDIR\.soduwork-versions\$target\SoduWork.exe"
    SetOutPath "$EXEDIR\.soduwork-versions\$target"
    ClearErrors
    Exec '"$EXEDIR\.soduwork-versions\$target\SoduWork.exe" $arguments'
    ${IfNot} ${Errors}
      SetErrorLevel 0
      Quit
    ${EndIf}
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
