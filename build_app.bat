@echo off
setlocal
pushd "%~dp0"

echo === LokaMeet: build installer/portable ===
echo Working dir: %CD%
echo.

REM Check for Node.js/npm
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js not found in PATH.
  echo Please install Node.js LTS from nodejs.org
  goto :fail
)
where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm not found in PATH.
  echo Please install Node.js LTS from nodejs.org
  goto :fail
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

echo Building release (NSIS + portable)...
call npm run dist
if errorlevel 1 goto :fail

echo.
echo Done. Output: "%CD%\release\"
echo.
popd
exit /b 0

:fail
echo.
echo Build failed.
popd
exit /b 1

