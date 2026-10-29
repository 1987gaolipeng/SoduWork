; Native UI only. Neither progress snapshots nor this window authorize a commit.
Var updateDialog
Var updateBar
Var updateStatus
Var updatePercent
Var updateHint
Var updateValue
Var updateFiles
Var updateTotal
Var updateTitleFont
Var updateBodyFont
Var updateIcon
Var updateRendered
Var updateEnglish

; UI language supplied by the running client: SODUWORK_UPDATE_LANG while the
; installer spawned this observer, .soduwork-update-locale in the install root for
; a shortcut opened during the transaction. The locale registry has no native
; ja/ko strings either and falls back to en-US, so en/ja/ko render English.
Function ReadUpdateLocale
  StrCpy $updateEnglish 0
  ReadEnvStr $0 "SODUWORK_UPDATE_LANG"
  ${If} $0 == ""
    StrCpy $1 ""
    ClearErrors
    FileOpen $2 "$updateRoot\.soduwork-update-locale" r
    ${IfNot} ${Errors}
      FileRead $2 $1
      FileClose $2
    ${EndIf}
    StrCpy $0 $1
  ${EndIf}
  ${StrCase} $0 $0 "L"
  StrCpy $1 $0 2
  ${If} $1 == "en"
  ${OrIf} $1 == "ja"
  ${OrIf} $1 == "ko"
  ${OrIf} $1 == "kr"
    StrCpy $updateEnglish 1
  ${EndIf}
FunctionEnd

Function CreateUpdatePage
  ; Hide all wizard furniture before the first frame, including navigation.
  System::Call 'user32::GetWindow(p $HWNDPARENT, i 5) p .r0'
  ${DoWhile} $0 != 0
    ShowWindow $0 0
    System::Call 'user32::GetWindow(p r0, i 2) p .r0'
  ${Loop}
  nsDialogs::Create 1018
  Pop $updateDialog
  ${If} $updateDialog == error
    SetErrorLevel 2
    Quit
  ${EndIf}
  SetCtlColors $updateDialog 24272D FFFFFF
  ; Dialog units follow the actual system font and DPI, not a hard-coded scale.
  System::Call '*(i 0, i 0, i 264, i 96) p .r0'
  System::Call 'user32::MapDialogRect(p $HWNDPARENT, p r0)'
  System::Call '*$0(i, i, i .r2, i .r3)'
  System::Call 'user32::SetWindowPos(p $updateDialog, p 0, i 0, i 0, i r2, i r3, i 0x14)'
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i .r1'
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20) i .r4'
  System::Call 'user32::AdjustWindowRectEx(p r0, i r1, i 0, i r4)'
  System::Call '*$0(i .r1, i .r4, i .r2, i .r3)'
  IntOp $2 $2 - $1
  IntOp $3 $3 - $4
  System::Free $0
  System::Call 'user32::MonitorFromWindow(p $HWNDPARENT, i 2) p .r0'
  System::Call '*(i 40, i, i, i, i, i, i, i, i, i) p .r1'
  System::Call 'user32::GetMonitorInfoW(p r0, p r1)'
  System::Call '*$1(i, i, i, i, i, i .r4, i .r5, i .r6, i .r7)'
  System::Free $1
  IntOp $6 $6 - $4
  IntOp $6 $6 - $2
  IntOp $6 $6 / 2
  IntOp $6 $6 + $4
  IntOp $7 $7 - $5
  IntOp $7 $7 - $3
  IntOp $7 $7 / 2
  IntOp $7 $7 + $5
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r6, i r7, i r2, i r3, i 0x14)'
  ; Retitle while the frame is still hidden, so English never flashes Chinese.
  ${If} $updateEnglish != 0
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:SoduWork is updating"
  ${EndIf}
  CreateFont $updateTitleFont "DengXian" 12 600
  CreateFont $updateBodyFont "DengXian" 10 400
  ${NSD_CreateIcon} 16u 12u 24u 24u ""
  Pop $0
  ${NSD_SetIconFromInstaller} $0 $updateIcon
  StrCpy $0 "正在更新 SoduWork"
  ${If} $updateEnglish != 0
    StrCpy $0 "Updating SoduWork"
  ${EndIf}
  ${NSD_CreateLabel} 48u 12u 200u 22u $0
  Pop $0
  SendMessage $0 ${WM_SETFONT} $updateTitleFont 1
  SetCtlColors $0 24272D FFFFFF
  StrCpy $0 "正在准备更新…"
  ${If} $updateEnglish != 0
    StrCpy $0 "Preparing update…"
  ${EndIf}
  ${NSD_CreateLabel} 16u 40u 196u 16u $0
  Pop $updateStatus
  SendMessage $updateStatus ${WM_SETFONT} $updateBodyFont 1
  SetCtlColors $updateStatus 555C67 FFFFFF
  ${NSD_CreateLabel} 216u 40u 32u 16u "0%"
  Pop $updatePercent
  ${NSD_AddStyle} $updatePercent ${SS_RIGHT}
  SendMessage $updatePercent ${WM_SETFONT} $updateBodyFont 1
  SetCtlColors $updatePercent 24272D FFFFFF
  nsDialogs::CreateControl "msctls_progress32" ${WS_CHILD}|${WS_VISIBLE}|1 0 16u 60u 232u 4u ""
  Pop $updateBar
  ; An unthemed native progress control permits the product's blue fill.
  ; PBS_SMOOTH, never PBS_MARQUEE: the filled length is measured work only.
  System::Call 'uxtheme::SetWindowTheme(p $updateBar, w "", w "")'
  SendMessage $updateBar 0x0409 0 0xFF853D
  SendMessage $updateBar 0x2001 0 0xF2EFEB
  SendMessage $updateBar 0x0406 0 100
  StrCpy $0 "完成后自动打开，会话和文件会保留"
  ${If} $updateEnglish != 0
    StrCpy $0 "Opens automatically when done. Sessions and files are kept."
  ${EndIf}
  ${NSD_CreateLabel} 16u 76u 232u 16u $0
  Pop $updateHint
  SendMessage $updateHint ${WM_SETFONT} $updateBodyFont 1
  SetCtlColors $updateHint 737A85 FFFFFF
  StrCpy $updateValue 0
  StrCpy $updateFiles 0
  StrCpy $updateTotal 0
  StrCpy $count 0
  Call ReadUpdateProgress
  ${NSD_CreateTimer} UpdateTick 250
  GetDlgItem $0 $HWNDPARENT 2
  EnableWindow $0 1
  ShowWindow $HWNDPARENT 5
  nsDialogs::Show
  Call CheckUpdateLock
  ${If} $updateBusy == 1
    SetErrorLevel 0
    Quit
  ${EndIf}
  Call LaunchPayload
FunctionEnd

Function ReadUpdateProgress
  StrCpy $1 ""
  ClearErrors
  FileOpen $0 "$updateRoot\.soduwork-update-phase" r
  ${IfNot} ${Errors}
    FileRead $0 $1
    FileClose $0
  ${EndIf}
  ${If} $1 == "extracting"
  ${OrIf} $1 == "verifying"
  ${OrIf} $1 == "activating"
  ${OrIf} $1 == "committed"
  ${OrIf} $1 == "preparing"
  ${OrIf} $1 == "cleaning"
    StrCpy $updatePhase $1
  ${EndIf}
  StrCpy $1 ""
  ClearErrors
  FileOpen $0 "$updateRoot\.soduwork-update-progress" r
  ${IfNot} ${Errors}
    FileRead $0 $1
    FileClose $0
  ${EndIf}
  ; Reject partial/malformed snapshots before numeric conversion.
  StrCpy $2 0
  StrCpy $3 0
  StrCpy $5 0
  validateProgress:
    StrCpy $4 $1 1 $2
    ${If} $4 == ""
      ${If} $3 != 2
      ${OrIf} $5 == 0
        Goto renderProgress
      ${EndIf}
      Goto validProgress
    ${EndIf}
    ${If} $4 == "|"
      ${If} $5 == 0
        Goto renderProgress
      ${EndIf}
      IntOp $3 $3 + 1
      StrCpy $5 0
    ${Else}
      ${StrStr} $6 "0123456789" $4
      ${If} $6 == ""
        Goto renderProgress
      ${EndIf}
      IntOp $5 $5 + 1
      ${If} $5 > 9
        Goto renderProgress
      ${EndIf}
    ${EndIf}
    IntOp $2 $2 + 1
    Goto validateProgress
  validProgress:
    ${StrTok} $2 $1 "|" 0 0
    ${StrTok} $3 $1 "|" 1 0
    ${StrTok} $4 $1 "|" 2 0
    ${If} $2 < $updateValue
    ${OrIf} $2 > 100
    ${OrIf} $3 > $4
      Goto renderProgress
    ${EndIf}
    ${If} $2 == 100
    ${AndIf} $updatePhase != "committed"
      Goto renderProgress
    ${EndIf}
    StrCpy $updateValue $2
    StrCpy $updateFiles $3
    StrCpy $updateTotal $4
  renderProgress:
    StrCpy $0 "$updatePhase|$updateValue|$updateFiles|$updateTotal"
    ${If} $0 == $updateRendered
      Return
    ${EndIf}
    StrCpy $updateRendered $0
    ${If} $updateEnglish != 0
      StrCpy $0 "Preparing update…"
      ${If} $updatePhase == "extracting"
        StrCpy $0 "Installing update"
      ${ElseIf} $updatePhase == "verifying"
        StrCpy $0 "Verifying files"
      ${ElseIf} $updatePhase == "activating"
        StrCpy $0 "Finishing installation"
      ${ElseIf} $updatePhase == "committed"
        StrCpy $0 "Update complete, opening"
      ${ElseIf} $updatePhase == "cleaning"
        StrCpy $0 "Cleaning up the old version"
      ${EndIf}
    ${Else}
      StrCpy $0 "正在准备更新…"
      ${If} $updatePhase == "extracting"
        StrCpy $0 "正在安装新版本"
      ${ElseIf} $updatePhase == "verifying"
        StrCpy $0 "正在校验文件"
      ${ElseIf} $updatePhase == "activating"
        StrCpy $0 "正在完成安装"
      ${ElseIf} $updatePhase == "committed"
        StrCpy $0 "更新完成，即将打开"
      ${ElseIf} $updatePhase == "cleaning"
        StrCpy $0 "正在整理旧版本"
      ${EndIf}
    ${EndIf}
    ${If} $updateTotal > 0
      StrCpy $0 "$0 · $updateFiles / $updateTotal"
    ${EndIf}
    ${NSD_SetText} $updateStatus "$0"
    ${NSD_SetText} $updatePercent "$updateValue%"
    SendMessage $updateBar 0x0402 $updateValue 0
FunctionEnd

Function UpdateTick
  Call ReadUpdateProgress
  Call CheckUpdateLock
  ${If} $updateBusy == 0
    ${NSD_KillTimer} UpdateTick
    ; Lock release alone is not success. The helper reports failed installs on
    ; reopening the preserved version; this observer never claims completion.
    ; Leave the nsDialogs modal loop before launching/quitting. NSIS Quit inside
    ; a timer callback does not unwind that loop and can strand the window.
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 1
    SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
    Return
  ${EndIf}
  IntOp $count $count + 1
  ${If} $count == 2400
    StrCpy $0 "安装耗时较长，正在等待系统完成文件写入"
    ${If} $updateEnglish != 0
      StrCpy $0 "This is taking longer than usual. Waiting for the system to finish writing files."
    ${EndIf}
    ${NSD_SetText} $updateHint $0
  ${EndIf}
FunctionEnd
