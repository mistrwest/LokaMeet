# Changelog

## 1.0.2

### Installer
- Default install path: `C:\Program Files\LokaMeet` (`perMachine: true`), folder choice kept.
- Force-close running `LokaMeet.exe` before file copy (fixes “Failed to close LokaMeet”).
- Custom NSIS welcome text and check-app-running logic in `build/installer.nsh`.

### Startup & i18n
- Name dialog on launch: **Cancel** and **×** quit the app (when opened later via Name — just closes).
- Full RU ↔ EN UI translation for previously hardcoded strings (settings, chat headers, tooltips, sounds, etc.).

### Status & call UI
- Speaking indicators in call tiles: brighter avatar ring and nick marker (no harsh glow on LAN list rings).
- Color status ring around avatars in the LAN user list.
- Status colors: online green, away light yellow, in-call / conference readable amber-yellow, DND redder, offline grey.
- “In call” / “In conference” badges more readable on dark themes.

### Build tooling
- `build_app.bat`: ASCII-safe messages (fixed cmd UTF-8 BOM / mojibake breakage).

## 1.0.1

- Previous public release baseline.
