@echo off
setlocal EnableExtensions EnableDelayedExpansion
pushd "%~dp0"

echo === LokaMeet: install dependencies ===
echo Working dir: %CD%
echo.

set "DO_BUILD=0"
set "DO_DIST=0"
set "DO_DEV=0"

if /I "%~1"=="build" set "DO_BUILD=1"
if /I "%~1"=="dist"  set "DO_DIST=1"
if /I "%~1"=="dev"   set "DO_DEV=1"

where node >nul 2>nul
if errorlevel 1 goto :node_missing
where npm >nul 2>nul
if errorlevel 1 goto :node_missing

echo Node:
node -v
echo npm:
npm -v
echo.

if exist node_modules (
  echo node_modules already exists - skipping install.
  goto :after_install
)

if exist package-lock.json (
  echo Installing dependencies (npm ci)...
  call npm ci
) else (
  echo Installing dependencies (npm install)...
  call npm install
)
if errorlevel 1 goto :fail

:after_install
echo.
if "%DO_BUILD%"=="1" (
  echo Building (renderer + main + preload)...
  call npm run build
  if errorlevel 1 goto :fail
)

if "%DO_DIST%"=="1" (
  echo Building release (NSIS + portable)...
  call npm run dist
  if errorlevel 1 goto :fail
)

if "%DO_DEV%"=="1" (
  echo Starting dev (Vite + Electron)...
  call npm run dev
  if errorlevel 1 goto :fail
)

echo.
echo Done.
popd
exit /b 0

:node_missing
echo ERROR: Node.js / npm not found in PATH.
echo.
echo Install Node.js LTS, then rerun this script.
echo - Winget (recommended):
echo   winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
echo - Or download from nodejs.org
echo.
echo After installation, close/reopen terminal so PATH updates.
popd
exit /b 1

:fail
echo.
echo FAILED.
echo If you see node-gyp errors, install Visual Studio Build Tools + Python, then rerun.
popd
exit /b 1

