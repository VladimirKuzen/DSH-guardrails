@echo off
rem ASCII only. Double-click to run the guardrails health check.
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-health.ps1"
if errorlevel 1 (
  echo.
  echo ============================================================
  echo  The script failed to start or exited with an error.
  echo  A parse error prints once and then the window closes.
  echo.
  echo  Check these, in order:
  echo    1. Run health-check.cmd  ^(script encoding check^)
  echo    2. Every .ps1 must be UTF-8 WITH BOM
  echo    3. Every .bat/.cmd must stay pure ASCII
  echo ============================================================
  pause
)
endlocal