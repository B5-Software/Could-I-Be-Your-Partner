@echo off
"%~dp0..\node\node.exe" "%~dp0launch.cjs" tui %*
exit /b %errorlevel%
