@echo off
echo Installing ARM64 build tools via vs_buildtools.exe...
"D:\vs_buildtools.exe" modify --installPath "D:\Program Files\Microsoft Visual Studio\18\Community" --add Microsoft.VisualStudio.Component.VC.Tools.ARM64 --add Microsoft.VisualStudio.Component.VC.14.50.18.0.ARM64 --add Microsoft.VisualStudio.Component.VC.14.50.18.0.ARM64.Spectre --passive --norestart --wait
echo Exit code: %ERRORLEVEL%
