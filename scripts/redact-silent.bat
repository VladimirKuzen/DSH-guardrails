@echo off
rem Silent variant for the scheduled task: no pause, writes to redact-shell.log
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0redact.ps1" -NoPause
endlocal