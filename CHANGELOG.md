# Changelog

## 1.1.0

### Camera & virtual background
- Dedicated Camera settings tab; preview matches the outgoing call image.
- Digital crop / zoom / pan without restarting the camera (sliders and drag on preview).
- On-device background replacement via MediaPipe Selfie Segmenter: blur (adjustable), 11 presets, and custom images stored locally.
- Remote peers receive the composited frame only; the model and background files stay on the sender’s PC.
- Manual camera controls when the device exposes them: focus, exposure, white balance, brightness, contrast, saturation, sharpness, optical zoom.
- Fixed black halos / spots around hands and moving objects with a preset background (mask no longer sticks, uncertain edges no longer leak the real dark room).

### Call recording
- Record 1:1 calls and conferences (including during screen share) to MP4 or AVI.
- Output folder, 480p–1440p, 15/24/30 FPS, bitrate presets.
- Visible recording indicator, chat system messages, optional start/stop sound.

### Video, screen share & call UX
- Outgoing camera quality: 360p, 480p, 720p, 1080p, 1440p, 4K (previously low / medium / high).
- Presenter’s camera overlay while screen sharing.
- Confirm before leaving a call or conference.
- Cancel an in-progress file transfer.

### Build
- New runtime dependency: `@mediapipe/tasks-vision`. WASM is copied from the package at build time; `public/mediapipe/selfie_segmenter_landscape.tflite` and `public/camera-bg/` ship with the app.

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
