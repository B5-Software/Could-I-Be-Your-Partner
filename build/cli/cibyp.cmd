@echo off
"%~dp0..\node\node.exe" "%~dp0launch.cjs" gui %*
exit /b %errorlevel%
