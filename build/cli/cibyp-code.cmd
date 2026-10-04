@echo off
"%~dp0..\node\node.exe" "%~dp0launch.cjs" code %*
exit /b %errorlevel%
