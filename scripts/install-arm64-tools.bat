@echo off
echo Installing ARM64 build tools for Visual Studio...
"C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify --installPath "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools" --add Microsoft.VisualStudio.Component.VC.Tools.ARM64 --add Microsoft.VisualStudio.Component.VC.14.50.18.0.ARM64 --add Microsoft.VisualStudio.Component.VC.14.50.18.0.ARM64.Spectre --passive --norestart
echo Exit code: %ERRORLEVEL%
