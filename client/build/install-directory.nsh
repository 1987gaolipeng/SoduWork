; Install into a directory that does not clobber another application's payload.
!macro soduworkSelectIndependentDirectory
  ; Never overwrite another application or share its payload, even when a client explicitly supplies its directory.
  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${If} ${FileExists} "$INSTDIR\SoduWork.exe"
      ${GetParent} "$INSTDIR" $0
      StrCpy $INSTDIR "$0\SoduWork"
    ${EndIf}
  ${EndIf}
!macroend
