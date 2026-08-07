@echo off
setlocal
pushd "%~dp0"

echo === LokaMeet: run app (instance B, test) ===
echo Working dir: %CD%

set "LOKAMEET_PROFILE=B"

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

if /I "%~1"=="nobuild" goto :skipbuild

echo Building (renderer + main + preload)...
call npm run build
if errorlevel 1 goto :fail

:skipbuild

echo Starting Electron (instance B)...
call npm start
popd
exit /b 0

:fail
echo.
echo Run failed.
popd
exit /b 1

