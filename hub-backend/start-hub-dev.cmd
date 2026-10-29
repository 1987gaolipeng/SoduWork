@echo off
set "HUB_ROOT=%~dp0"
cd /d "%HUB_ROOT%"
if not exist ".venv-hub\Scripts\python.exe" (
  echo Missing .venv-hub\Scripts\python.exe 1>&2
  exit /b 1
)
if not exist ".runtime" mkdir ".runtime"
".venv-hub\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 9080 > ".runtime\hub-dev-9080.log" 2>&1
