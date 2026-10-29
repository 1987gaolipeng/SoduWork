; This is deliberately the only shadowed upstream template.
!include "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis\include\installer.nsh"
!include "${BUILD_RESOURCES_DIR}\install-versioned.nsh"

!ifdef ONE_CLICK
  ${IfNot} ${Silent}
  ${OrIf} ${isForceRun}
    HideWindow
    !insertmacro StartApp
  ${EndIf}
  !insertmacro quitSuccess
!else
  ${If} ${Silent}
  ${AndIf} ${isForceRun}
    HideWindow
    !insertmacro StartApp
  ${EndIf}
!endif
