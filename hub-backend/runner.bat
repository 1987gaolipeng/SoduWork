@echo off
REM SoduWork standalone Runner startup script.
REM
REM Double-click to run, or place this launcher in shell:startup to start at login.
REM   runner.bat                      Connect to the local backend.
REM   runner.bat ws://192.0.2.40:9080   Connect to a backend on the local network.
REM
REM Run independently so the same execution implementation can operate on client or server machines.
REM The local and remote execution paths can coexist during rollout.
setlocal
set HUB=%~1
if "%HUB%"=="" set HUB=ws://127.0.0.1:9080
cd /d "%~dp0"
echo [SoduWork] 执行机启动，连 %HUB%
".venv\Scripts\python.exe" runner_main.py --hub %HUB% %SODUWORK_RUNNER_ARGS%
endlocal
