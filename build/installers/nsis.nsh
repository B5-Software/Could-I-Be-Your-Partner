; SPDX-License-Identifier: GPL-3.0-or-later
!macro customInstall
  StrCpy $R1 "User"
  ${If} $installMode == "all"
    StrCpy $R1 "Machine"
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli\register.ps1" -Action Install -Directory "$INSTDIR\resources\cli" -Scope $R1'
  Pop $R0
  ${If} $R0 != 0
    MessageBox MB_ICONEXCLAMATION "Command path registration failed. You can run cibyp.cmd and cibyp-tui.cmd in $INSTDIR\resources\cli."
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    StrCpy $R1 "User"
    ${If} $installMode == "all"
      StrCpy $R1 "Machine"
    ${EndIf}
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli\register.ps1" -Action Remove -Directory "$INSTDIR\resources\cli" -Scope $R1'
    Pop $R0
  ${EndIf}
!macroend
