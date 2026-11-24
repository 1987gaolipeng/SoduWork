@echo off
setlocal
set "SODUWORK_PREVIOUS_CP="
for /f "tokens=2 delims=:" %%a in ('chcp 2^>nul') do set "SODUWORK_PREVIOUS_CP=%%a"
if defined SODUWORK_PREVIOUS_CP chcp 65001 >nul 2>nul
if not defined PYTHONUTF8 set "PYTHONUTF8=1"
if not defined PYTHONIOENCODING set "PYTHONIOENCODING=utf-8"
cd /d "%~dp0"
where py <nul >nul 2>nul
if errorlevel 1 goto python
py -3.12 --version <nul >nul 2>nul
if errorlevel 1 goto py_latest
py -3.12 start.py %*
goto finished
:py_latest
py -3 start.py %*
goto finished
:python
where python <nul >nul 2>nul
if errorlevel 1 goto missing
python start.py %*
goto finished
:missing
echo Install Python 3.12 or newer from https://www.python.org/downloads/
echo Enable "Add Python to PATH", then run this file again.
cmd /c exit 1
:finished
set "SODUWORK_START_EXIT=%errorlevel%"
if "%SODUWORK_START_EXIT%"=="0" goto done
if "%SODUWORK_NO_PAUSE%"=="1" goto done
:check_pause
if [%1]==[] goto pause_on_error
if "%~1"=="--password-stdin" goto done
shift
goto check_pause
:pause_on_error
pause
:done
if defined SODUWORK_PREVIOUS_CP chcp %SODUWORK_PREVIOUS_CP% >nul 2>nul
exit /b %SODUWORK_START_EXIT%
