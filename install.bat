@echo off
setlocal EnableExtensions EnableDelayedExpansion
title LokaMeet - install
chcp 65001 >nul
pushd "%~dp0"

set "PAUSE_AT_END=1"
if /I "%~1"=="nopause" set "PAUSE_AT_END=0"

echo === LokaMeet: установка (зависимости + сборка, без запуска) ===
echo Каталог: %CD%
echo.
echo Этот скрипт делает то же, что run_app.bat, но не запускает программу:
echo   1^) проверяет Node.js / npm
echo   2^) ставит библиотеки ^(npm install^)
echo   3^) скачивает Electron, если его нет
echo   4^) собирает renderer + main + preload
echo.

if not exist "package.json" (
  echo ОШИБКА: не найден package.json
  echo Запускайте install.bat из папки проекта LokaMeet.
  goto :fail
)

call :ensure_nodejs
if errorlevel 1 goto :fail

echo Node: 
node -v
echo npm:
call npm -v
echo.

echo --- Зависимости ---
if exist "node_modules" (
  echo Папка node_modules есть. Проверяю комплектность и докачиваю недостающее...
) else (
  echo Папка node_modules не найдена. Нужно скачать все библиотеки.
)

echo Установка: npm install ^(как в run_app.bat^)
call npm install
if errorlevel 1 (
  echo.
  echo npm install не удался.
  echo Частые причины: нет интернета, блокировка npm, антивирус.
  echo Повторить попытку? [Y/N]
  set /p "RETRY= > "
  if /I "!RETRY!"=="Y" goto :retry_npm
  if /I "!RETRY!"=="Д" goto :retry_npm
  if /I "!RETRY!"=="ДА" goto :retry_npm
  goto :fail
)
goto :after_npm

:retry_npm
echo Повтор npm install...
call npm install
if errorlevel 1 goto :fail

:after_npm
call :check_packages
if errorlevel 1 (
  echo.
  echo Часть пакетов не установилась. Пробую npm install ещё раз...
  call npm install
  call :check_packages
  if errorlevel 1 goto :fail
)

call :ensure_electron
if errorlevel 1 goto :fail

echo.
echo --- Сборка ---
echo Собираю renderer + main + preload...
call npm run build
if errorlevel 1 (
  echo.
  echo Сборка не удалась.
  goto :fail
)

call :check_build
if errorlevel 1 goto :fail

echo.
echo ============================================
echo Установка завершена. Программа собрана и готова.
echo Запуск: run_app.bat   ^(или npm start^)
echo Программа сейчас НЕ запускалась.
echo ============================================
call :maybe_pause
popd
exit /b 0

:ensure_nodejs
call :refresh_node_path
where node >nul 2>nul
if errorlevel 1 goto :node_missing
where npm >nul 2>nul
if errorlevel 1 goto :node_missing
exit /b 0

:node_missing
echo ОШИБКА: не найден Node.js или npm в PATH.
echo Без Node.js нельзя поставить библиотеки и собрать проект.
echo Нужен Node.js LTS: https://nodejs.org
echo.
where winget >nul 2>nul
if errorlevel 1 goto :node_no_winget

echo Установить Node.js LTS через winget сейчас? [Y/N]
set /p "ANS= > "
if /I not "!ANS!"=="Y" if /I not "!ANS!"=="Д" if /I not "!ANS!"=="ДА" (
  echo Установка Node.js пропущена.
  exit /b 1
)
echo Запускаю winget...
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo winget не смог установить Node.js.
  echo Открыть страницу загрузки в браузере? [Y/N]
  set /p "OPEN= > "
  if /I "!OPEN!"=="Y" start "" "https://nodejs.org"
  if /I "!OPEN!"=="Д" start "" "https://nodejs.org"
  echo После установки закройте это окно и снова запустите install.bat
  exit /b 1
)
call :refresh_node_path
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js установлен, но текущее окно ещё не видит PATH.
  echo Закройте окно и снова запустите install.bat
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm не найден после установки Node.js. Перезапустите install.bat
  exit /b 1
)
echo Node.js найден.
exit /b 0

:node_no_winget
echo winget не найден, автоматическая установка недоступна.
echo Открыть страницу загрузки Node.js? [Y/N]
set /p "OPEN= > "
if /I "!OPEN!"=="Y" start "" "https://nodejs.org"
if /I "!OPEN!"=="Д" start "" "https://nodejs.org"
if /I "!OPEN!"=="ДА" start "" "https://nodejs.org"
echo После установки Node.js снова запустите install.bat
exit /b 1

:refresh_node_path
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%LocalAppData%\Programs\nodejs;%PATH%"
call :append_reg_path "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
call :append_reg_path "HKCU\Environment"
exit /b 0

:append_reg_path
set "REG_PATH="
for /f "tokens=2*" %%A in ('reg query %1 /v Path 2^>nul') do set "REG_PATH=%%B"
if defined REG_PATH set "PATH=%REG_PATH%;%PATH%"
exit /b 0

:check_packages
set "MISSING=0"
call :need_dir "node_modules\react" "react"
call :need_dir "node_modules\react-dom" "react-dom"
call :need_dir "node_modules\electron" "electron"
call :need_dir "node_modules\typescript" "typescript"
call :need_dir "node_modules\vite" "vite"
call :need_dir "node_modules\ws" "ws"
call :need_dir "node_modules\@mediapipe\tasks-vision" "@mediapipe/tasks-vision"
call :need_dir "node_modules\i18next" "i18next"
call :need_dir "node_modules\bonjour-service" "bonjour-service"
if "!MISSING!"=="1" (
  echo Не хватает пакетов в node_modules.
  exit /b 1
)
echo Основные пакеты на месте.
exit /b 0

:need_dir
if exist "%~1" exit /b 0
echo   нет: %~2
set "MISSING=1"
exit /b 0

:ensure_electron
if exist "node_modules\electron\dist\electron.exe" (
  echo Electron: найден
  exit /b 0
)
echo Не найден node_modules\electron\dist\electron.exe — докачиваю...
if not exist "node_modules\electron\install.js" (
  echo Нет скрипта установки Electron. Сначала должен пройти npm install.
  exit /b 1
)
call node "node_modules\electron\install.js"
if errorlevel 1 (
  echo Не удалось скачать Electron автоматически.
  echo Повторить загрузку Electron? [Y/N]
  set /p "EL= > "
  if /I "!EL!"=="Y" goto :ensure_electron
  if /I "!EL!"=="Д" goto :ensure_electron
  if /I "!EL!"=="ДА" goto :ensure_electron
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron так и не появился после загрузки.
  echo Повторить? [Y/N]
  set /p "EL= > "
  if /I "!EL!"=="Y" goto :ensure_electron
  if /I "!EL!"=="Д" goto :ensure_electron
  exit /b 1
)
echo Electron: скачан
exit /b 0

:check_build
set "MISSING=0"
if not exist "dist\main\main.js" (
  echo   нет: dist\main\main.js
  set "MISSING=1"
)
if not exist "dist\preload\preload.js" (
  echo   нет: dist\preload\preload.js
  set "MISSING=1"
)
if not exist "dist\renderer\index.html" (
  echo   нет: dist\renderer\index.html
  set "MISSING=1"
)
if "!MISSING!"=="1" (
  echo Сборка прошла, но не все файлы на месте.
  exit /b 1
)
echo Сборка: dist\main, dist\preload, dist\renderer — ок
exit /b 0

:fail
echo.
echo Установка не завершена.
echo Когда исправите проблему, запустите install.bat снова.
call :maybe_pause
popd
exit /b 1

:maybe_pause
if "%PAUSE_AT_END%"=="1" pause
exit /b 0
