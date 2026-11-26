@echo off
setlocal
pushd "%~dp0"

echo === LokaMeet: portable build ===
echo Working dir: %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js not found in PATH.
  echo Install Node.js LTS from nodejs.org
  goto :fail
)
where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm not found in PATH.
  echo Install Node.js LTS from nodejs.org
  goto :fail
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

echo Building portable EXE...
call npm run dist -- --win portable
if errorlevel 1 goto :fail

echo.
set "PORTABLE="
for %%F in ("release\LokaMeet-Portable-*.exe") do set "PORTABLE=%%~fF"
if not defined PORTABLE (
  echo ERROR: LokaMeet-Portable-*.exe was not created in release\
  goto :fail
)

echo Done.
echo   %PORTABLE%
echo.
echo Opening release folder...
start "" explorer "%CD%\release"
popd
exit /b 0

:fail
echo.
echo Build failed.
popd
exit /b 1
