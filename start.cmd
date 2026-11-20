@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 goto python
py -3.12 --version >nul 2>nul
if errorlevel 1 goto py_latest
py -3.12 start.py %*
goto finished
:py_latest
py -3 start.py %*
goto finished
:python
where python >nul 2>nul
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
exit /b %SODUWORK_START_EXIT%
