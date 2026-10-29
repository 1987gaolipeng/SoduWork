@echo off
REM Launch the SoduWork desktop app in a clean environment.
REM WorkBuddy sandbox injects NODE_OPTIONS=--use-system-ca which Electron 30 rejects,
REM and ELECTRON_RUN_AS_NODE which makes Electron run as pure Node (app undefined).
REM This script strips those vars before launching.
setlocal
set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="
REM Clear inherited Chromium crashpad and sandbox environment settings before launch.
REM Child shells from other Chromium applications may inherit parent-specific handles.
REM Those handles can prevent transparent-window compositing despite a live renderer.
REM Normal user launches generally leave these values unset.
set "CHROME_CRASHPAD_PIPE_NAME="
set "CHROME_CRASHPAD_PIPE_HANDLE="
set "NODE_USE_SYSTEM_CA="
set "CHROME_DEVEL_SANDBOX="
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" . %*
endlocal
