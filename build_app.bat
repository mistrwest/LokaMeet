@echo off
setlocal
pushd "%~dp0"

echo === LokaMeet: build installer + portable ===
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

if not exist "build\icon.png" (
  echo ERROR: missing build\icon.png - required for the installer.
  goto :fail
)

if not exist "build\installer.nsh" (
  echo ERROR: missing build\installer.nsh
  goto :fail
)

if not exist "build\license.txt" (
  echo ERROR: missing build\license.txt
  goto :fail
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

echo Cleaning old release artifacts (including legacy LanMeet Setup)...
if exist "release" (
  del /q "release\LanMeet*.exe" 2>nul
  del /q "release\LanMeet*.blockmap" 2>nul
  del /q "release\LokaMeet*.exe" 2>nul
  del /q "release\LokaMeet*.blockmap" 2>nul
  del /q "release\lokameet-*.nsis.7z" 2>nul
  del /q "release\*.yml" 2>nul
)

echo Building release:
echo   - NSIS Setup  (wizard: description, license, folder choice^)
echo   - Portable EXE
echo.
call npm run dist
if errorlevel 1 goto :fail

echo.
set "SETUP="
for %%F in ("release\LokaMeet-Setup-*.exe") do set "SETUP=%%~fF"
if not defined SETUP (
  echo ERROR: LokaMeet-Setup-*.exe was not created in release\
  goto :fail
)

echo Done.
echo.
echo Use the NEW installer (not LanMeet Setup 0.1.0^):
echo   %SETUP%
echo.
echo Portable:
for %%F in ("release\LokaMeet-Portable-*.exe") do echo   %%~fF
echo.
echo Do NOT run old "LanMeet Setup *.exe" files - that is the one-click 0.1.0 installer.
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
