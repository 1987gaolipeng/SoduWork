@echo off
setlocal
cd /d "%~dp0..\.."
where py >nul 2>nul
if not errorlevel 1 (
  py -3 ops\self-host\deploy.py %*
) else (
  python ops\self-host\deploy.py %*
)
exit /b %errorlevel%
