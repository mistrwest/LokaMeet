# Changelog

## 1.4.0

### Added
- Screen share follows the monitor refresh rate, from 60 to 120 fps. The current rate is shown in Media settings, under video quality. Capture resolution matches the screen and the frame is not cropped.
- Voice-activated microphone with a sensitivity slider on the Audio tab. Higher opens the mic on a quieter voice. Silence is not sent.
- Checkers, chess and battleship can be played against the computer at easy, medium or hard.
- Manual camera controls are shown only when the device exposes them.
- Open logs folder and clear chat history live on the Interface tab.

### Fixed
- Screen-share video is no longer cropped or frame-dropped. Motion stays close to the original picture.
- Voice activation no longer swallows the start of a word or the gap between words, and it no longer degrades the remote microphone.
- Outgoing voice stays at a normal level. Noise suppression no longer ducks the talker or restarts the shared audio device.
- Background blur and replacement hold the silhouette: edges do not flicker, the real room does not leave a rim, and a covered face does not erase the head.
- Continuous autofocus hunts again with the face visible or covered, so the lens does not stay soft and the background follows the person.

## 1.3.0

### Added
- A chat message with a screenshot, link or GIF is sent as one bubble, caption included.
- Messages can be quoted.
- Games: a separate “Play with them” button next to “Vs computer”.
- Chat previews open on click. Pictures, animated images, video files and VK clips play in a viewer.
- Paste no longer sends immediately. Text and pasted files wait until Send.
- Recording start and stop messages are highlighted in the chat.
- The taskbar button flashes on a chat message or call event when the window is not focused.

### Fixed
- Turning the camera off no longer silences the microphone, with or without a screen share that includes audio.
- A still image during screen share no longer flickers. Moving picture is unchanged.

## 1.2.0

### Games in calls
- Play during a 1:1 call or conference: Russian draughts, chess and battleship.
- Invite an opponent; other conference participants can spectate a live game.
- Resign, offer/accept a draw, rematch with match score; collapse the board back to video tiles or open fullscreen.
- Per-user game settings: board size, coordinates, last-move highlight, sounds, move hints, resign confirmation.

### Chess
- Full rules: all pieces, check/checkmate, stalemate, castling, en passant, promotion, 50-move rule, threefold repetition, insufficient material.
- Wooden board and Staunton-style pieces; captured material and evaluation shown in the HUD.

### Checkers
- Russian draughts: flying kings, mandatory captures, match score.

### Battleship
- 10×10 fleet placement, fog of war, hit/sunk feedback, match score.

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
