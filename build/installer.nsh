; Кастомный NSIS для LokaMeet (electron-builder).

!macro customHeader
  !define MUI_WELCOMEPAGE_TITLE "Установка LokaMeet"
  !define MUI_WELCOMEPAGE_TEXT "LokaMeet 1.1.0 — десктоп‑приложение для видеосвязи в локальной сети без интернета и без облака.$\r$\n$\r$\n• Личные аудио/видеозвонки и групповые конференции (P2P WebRTC)$\r$\n• Виртуальный фон камеры и запись звонков (MP4 / AVI)$\r$\n• Чат, обмен файлами и демонстрация экрана$\r$\n• Автообнаружение пользователей в LAN$\r$\n$\r$\nВы сможете выбрать папку установки на следующем шаге.$\r$\n$\r$\n$_CLICK"
!macroend

; Electron держит несколько процессов — штатный soft-close часто не успевает.
; Принудительно завершаем дерево процессов перед копированием файлов.
!macro customCheckAppRunning
  DetailPrint "Closing LokaMeet..."
  StrCpy $R1 0

  close_loop:
    nsExec::ExecToLog `taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
    Pop $0
    Sleep 700

    nsExec::ExecToStack `cmd /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | find /I "${APP_EXECUTABLE_FILENAME}" >nul`
    Pop $0
    ${if} $0 != 0
      Goto close_done
    ${endif}

    IntOp $R1 $R1 + 1
    ${if} $R1 < 4
      Goto close_loop
    ${endif}

    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY close_loop
    Quit

  close_done:
!macroend

; Папка logs рядом с программой должна быть доступна обычному пользователю,
; даже если LokaMeet установлен в Program Files.
!macro customInstall
  CreateDirectory "$INSTDIR\logs"
  nsExec::ExecToLog `icacls "$INSTDIR\logs" /grant *S-1-5-32-545:(OI)(CI)M /T /C /Q`
!macroend
