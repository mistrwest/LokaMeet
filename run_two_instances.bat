@echo off
setlocal
pushd "%~dp0"

echo === LokaMeet: run two instances (A+B) ===
echo Working dir: %CD%

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

echo Building (renderer + main + preload)...
call npm run build
if errorlevel 1 goto :fail

echo Starting instance A...
start "LokaMeet A" cmd.exe /k ""%~dp0run_app.bat" nobuild"

timeout /t 2 /nobreak >nul

echo Starting instance B...
start "LokaMeet B" cmd.exe /k ""%~dp0run_app_2.bat" nobuild"

echo.
echo Both instances started.
popd
exit /b 0

:fail
echo.
echo Failed.
popd
exit /b 1

