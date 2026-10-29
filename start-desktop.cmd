@echo off
call "%~dp0start.cmd" --desktop %*
exit /b %errorlevel%
