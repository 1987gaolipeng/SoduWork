; Controlled reproduction of the old delete-before-install ordering.
; Only a test-owned directory selected at compile time is allowed.
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${SODUWORK_E2E_BASELINE_OUT}"
Section
  StrCpy $INSTDIR "${SODUWORK_E2E_ROOT}"
  IfFileExists "$INSTDIR\.soduwork-e2e-owned" +2
    Quit
  Delete "$INSTDIR\SoduWork.exe"
  Sleep 1500
  CopyFiles /SILENT "$INSTDIR\SoduWork.pre-test.exe" "$INSTDIR\SoduWork.exe"
SectionEnd
