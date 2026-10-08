@echo off
REM CodeForge CLI installer for Windows CMD. Delegates to install.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-RestMethod https://www.codeforge.dev/install.ps1 | Invoke-Expression"
if errorlevel 1 exit /b 1
