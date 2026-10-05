@echo off
"%~dp0..\node\node.exe" "%~dp0launch.cjs" webui %*
exit /b %errorlevel%
