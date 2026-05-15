# CamNet – Multi-Phone Camera Monitor

## Project Overview

CamNet is a peer-to-peer multi-phone LAN security camera app. One phone acts as a **Monitor** (viewing hub), and other phones become **Cameras** (video sources). All communication happens locally over WiFi — no cloud, no APIs.

**Core Value:** Transform spare old phones into a cohesive security camera system with on-device AI motion detection, timelapse, and recording.

---

## Architecture

### Two-Port Design
- **Port 3000 (HTTP):** Ktor CIO server for Monitor UI (web app served via `loadDataWithBaseURL`)
- **Port 3443 (HTTPS):** SslProxy (raw TCP byte-copying SSL termination) for Camera phones on LAN

### WebRTC Signaling Flow
1. Monitor starts session (6-char room code, QR code, LAN IP)
2. Camera joins with code → WebSocket handshake with signaling server
3. ICE candidates & SDP offers/answers exchanged via WS
4. Peer connection established → audio/video stream flows directly between phones
5. Viewer receives stream, renders in `<video>`, motion detection on 160×120 canvas

### Key Components

| File | Role |
|------|------|
| `CamNetServer.kt` | Ktor server, WS signaling, HTTP asset serving, session management |
| `SslProxy.kt` | Raw socket SSL termination (passes WS upgrades transparently) |
| `MainActivity.kt` | Native Android UI wrapper; loads web views via `loadDataWithBaseURL` |
| `AndroidBridge.kt` | JavascriptInterface: `saveSnapshot`, `saveVideo`, `startStreaming`, `stopStreaming` |
| `public/js/viewer.js` | Monitor: WebRTC peer mgmt, motion detection, recording, timelapse, AI detection |
| `public/js/camera.js` | Camera: media capture, torch, mic, quality, bitrate, stealth mode, recording |
| `public/viewer.html` | Monitor UI (session mgmt, layout, settings, camera cards) |
| `public/camera.html` | Camera UI (join form, live screen, quality settings) |
| `public/index.html` | Home screen with role selection (Monitor/Camera) |
| `public/css/app.css` | All styling (fullscreen, motion indicator, timelapse picker, etc.) |

---

## Current Features (Complete)

### Monitor (Viewer)
- ✅ Real-time multi-camera grid (auto, 1, 2, 3 col layout)
- ✅ Per-camera controls: snapshot, record, timelapse, mute, nightvision, flip, quality, stealth
- ✅ Motion detection: pixel-diff on downsampled canvas, zone picker with "clear zone" option
- ✅ **Smart Detection (AI):** TensorFlow.js + COCO-SSD (lite_mobilenet_v2)
  - Lazy-loaded from jsDelivr CDN (~3 MB)
  - Filters detected objects by `smartClasses` (8 configurable: Person/Car/Motorcycle/etc.)
  - Per-camera 3s cooldown + `pendingSmartDetect` guard prevents parallel inference
  - **Fallback:** If AI model fails to load, basic motion alerts fire automatically
- ✅ Motion alerts: text + toast, 4s display, auto-dismiss
- ✅ Settings panel: motion sensitivity (Low/Mid/High), auto-snapshot on motion, flash on motion + duration (1/2/5/10 min), mute all, mirror front cams, photo quality (480/720/1080/Source)
- ✅ Timelapse picker: interval/duration inputs, photo quality (use global / local override), video quality (480/720/1080), unlimited toggle, live file size estimate (JPEG + video bytes)
- ✅ Recording: local + remote options, 5-min segmentation (REC_SEGMENT_MS), WebM codec
- ✅ Fullscreen: CSS-based (native API fails on Android WebView)
- ✅ Session info panel: room code, QR code, copy code/link buttons
- ✅ Auto-snapshot and flash on motion (with persistence across disconnects)

### Camera (Phone)
- ✅ Join session with 6-char code or auto-join via QR `?room=XXXX` param
- ✅ 30-second connection timeout: if no `joined` msg after 30s, returns to setup
- ✅ Local recording (5-min segments), save to gallery
- ✅ Mic toggle (echoCancellation + noiseSuppression)
- ✅ Torch/flash control
- ✅ Quality picker (240/480/720/1080p) with bitrate enforcement
- ✅ Camera flip (front/rear)
- ✅ Stealth mode: black overlay, wake lock held, 3-tap exit
- ✅ Keep-alive: silent 0.001v audio + MediaSession to prevent OS tab suspension
- ✅ Wake lock (WakeLock API)
- ✅ Toast feedback on all button actions
- ✅ **Cancel button on setup screen** (visible while "Connecting…" state)
- ✅ **Back button on live screen** (return to setup)

### Branding
- ✅ App icon: camera lens (concentric rings, center 44,54) + 3 wifi arcs radiating right
- ✅ icon-192.svg, icon-512.svg: camera lens design, #090910 background, #3B82F6 lens, white arcs
- ✅ Home page logo: inline SVG (no emoji)
- ✅ Android native home screen: SVG logo before "CamNet" title
- ✅ Manifest name: "CamNet"

---

## Known Issues & Fixes

### Fixed (Latest)
- ✅ **Motion detection silent failure (commit b42d5d9):**
  - Bug: `smartDetectionEnabled=true` but `cocoModel=null` → neither AI nor basic alert fired
  - Fix: Changed condition to `!smartDetectionEnabled || !cocoModel` so basic detection fires as fallback
  - **Status:** Fixed, awaiting user test
  
- ✅ **No cancel on camera live screen:**
  - Added "← Cancel" button to setup screen (shows while loading)
  - Added "‹" back button to live screen status bar
  - Both call `hangup()` → return to setup

- ✅ **Camera controls hidden tap zone:**
  - CSS: `.cam-controls` missing `pointer-events: none` when hidden
  - Fixed with opacity:0 + pointer-events:none

- ✅ **Connection duplicate cards on reconnect:**
  - `onCameraJoined` was overwriting peer map entry without closing old RTCPeerConnection
  - Fixed: check existing peer, close + remove DOM card first

- ✅ **QR scanner hidden after Monitor→Back→Camera:**
  - `BarcodeDetector` in-window check unreliable on second navigation
  - Fixed: always show button, check inside `startScan()`

- ✅ **Fullscreen button non-functional:**
  - Native `requestFullscreen()` silently fails on Android WebView (no WebChromeClient.onShowCustomView)
  - Fixed: CSS `.cam-fullscreen` class (position:fixed, inset:0, z-index:9000)

### Testing Checklist
- [ ] Motion detection fires in both basic and AI modes
- [ ] Cancel button works on setup screen during connection attempt
- [ ] Back button on live screen returns to setup
- [ ] Timelapse picker displays correct file size estimates
- [ ] Photo quality setting applied to snapshots
- [ ] Smart detection filters by configured object classes
- [ ] Flash stays on for selected duration after motion
- [ ] Recording segments at 5 minutes
- [ ] QR scanner accessible after navigating back from live screen

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Server | Kotlin (Ktor/CIO) |
| Android | Kotlin, WebView, AndroidBridge (JavascriptInterface) |
| Web (Monitor/Camera) | HTML5, Vanilla JS, WebRTC, MediaRecorder |
| Styling | CSS Grid, flexbox |
| AI | TensorFlow.js + COCO-SSD (lite_mobilenet_v2) |
| Assets | SVG icons, JSON manifests |

---

## Development Notes

### Motion Detection Pipeline
1. Start motion analysis: `startMotion(cameraId)` creates 160×120 canvas, copies video frames every 400ms
2. Pixel-diff: compare each pixel ±threshold, count changed pixels
3. Zone constraint: if zone exists, only analyze rect region; else full frame
4. Trigger: if `changed/total > fraction` AND `now >= lastMotionAt + 15s cooldown` → fire alert
5. AI branch: if `smartDetectionEnabled && cocoModel && !pendingSmartDetect` → run inference (3s per-camera cooldown)
6. Fallback: if AI mode but model unavailable (or disabled) → basic alert always fires
7. Alert display: 4-second toast + motion indicator pill (green pulsing "MOTION ON" / "WATCHING ZONE" / "AI WATCHING" / "AI · ZONE")

### Recording Strategy
- **Monitor (viewer.js):** MediaRecorder on received stream, 5-min segments, auto-upload to Monitor phone gallery
- **Camera (camera.js):** MediaRecorder on local stream, WebM codec, 5-min segments, save via AndroidBridge.saveVideo() to gallery
- **Multipart upload:** Camera sends POST /api/save-video with X-Filename header (for on-device storage if Monitor is unavailable)

### Timelapse Strategy
- Frame capture: snapshot every N interval, compress as JPEG (quality varies by `photoQuality`)
- Photo mode: save each frame directly to gallery (individual JPEGs)
- Video mode: accumulate frames → render via MediaRecorder canvas stream at 24fps → save WebM with selected bitrate
- Size estimate: JPEG bytes by resolution bucket + (bitrate × frame count / 24 / 8) for video

### CSS Fullscreen
- Approach: `.cam-fullscreen { position:fixed; inset:0; z-index:9000; }` applied to card
- Why not native: Android WebView's fullscreen API requires `WebChromeClient.onShowCustomView()` callback (app would need custom WebChromeClient)
- Trade-off: CSS fullscreen works reliably, no native UI bloat, user can still see system time/battery

### AI Model Lazy Loading
- Path: `https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.2/dist/coco_ssd.js`
- Trigger: first toggle of Smart Detection, or auto-load on Settings panel open
- Promise: `cocoLoadingPromise` prevents duplicate fetches during parallel toggles
- Fallback: if load fails (network, CDN down), `cocoModel = null`, basic motion fires

---

## Build & Deployment

### Android
```bash
cd android
# Requires Android SDK, NDK, Kotlin compiler
./gradlew assembleRelease
# APK generated at: app/build/outputs/apk/release/
```

### Web (Development)
```bash
npm start  # or: node public/server.js
# Server: http://localhost:3000
# Camera: https://LAN_IP:3443/camera.html
```

### Deployment Steps
1. Build APK on development machine
2. Install on Monitor phone + all Camera phones
3. Start Monitor app → note session code / QR code
4. Open Camera app on each phone → enter code → stream begins
5. All communication stays on LAN (no internet required)

---

## Session Persistence & State

### Monitor (viewer.js)
- **Peers map:** `cameraId → { pc, name, stream, motion, recorder, timelapse, zone, lastMotionAt, ... }`
- **Recording state:** per-peer + global settings (sensitivity, flash duration, auto-snapshot, smart detection, etc.)
- **UI state:** hidden in localStorage (layout choice, settings panel open/close) — *not currently persisted, could be added*

### Camera (camera.js)
- **Local state:** `roomId, cameraId, localStream, recordActive, torchOn, facingMode, quality, micEnabled`
- **Reconnect:** on WS close, auto-retry every 3s up to 10 attempts (30s total), then give-up timer fires
- **Recording reset:** on `joined` msg, clear any stale recording state + call `stopCameraRecording()`

### Persistence Gaps
- Settings not saved across sessions (motion sensitivity, photo quality, smart class toggles, etc.) — could add localStorage
- Camera name optional; no persistent phone identity

---

## Future Enhancements (Not Implemented)

- [ ] Persistent settings (localStorage for sensitivity, quality, etc.)
- [ ] Person detection with face recognition (privacy-local)
- [ ] Geofencing trigger (location-based alerting)
- [ ] Custom motion zones per camera (drawn polygons)
- [ ] 24/7 DVR mode (rolling buffer, search by time)
- [ ] Two-way audio (mic from Monitor phone to Camera)
- [ ] Night vision mode (IR LED control, if supported)
- [ ] Cloud backup (optional, user-controlled)

---

## Getting Help

**For Claude Code sessions:**
- This CLAUDE.md is auto-loaded; ask directly about features, architecture, or bugs
- Refer to file paths: e.g., "Fix the motion detection in `public/js/viewer.js:974`"

**For Chat projects:**
- Upload this file to a Claude.ai Project so Chat has context
- Re-upload whenever I say "update CLAUDE.md"
- Chat can then answer high-level questions about the app state

---

## Repository Structure

```
camnet/
├── android/
│   └── app/src/main/
│       ├── java/com/camnet/app/
│       │   ├── MainActivity.kt          # WebView host, home/setup/camera screens
│       │   ├── CamNetServer.kt         # Ktor server + WS signaling
│       │   ├── SslProxy.kt             # HTTPS termination
│       │   ├── AndroidBridge.kt        # JS interface (save snapshots/videos)
│       │   └── CamNetService.kt        # Foreground service (keep camera alive)
│       └── res/
│           ├── drawable/ic_launcher_foreground.xml  # App icon vector
│           ├── mipmap-anydpi-v26/ic_launcher.xml    # Adaptive icon
│           └── values/colors.xml
├── public/
│   ├── index.html                      # Home screen (role select)
│   ├── viewer.html                     # Monitor UI
│   ├── camera.html                     # Camera UI
│   ├── js/
│   │   ├── viewer.js                   # Monitor logic (motion, recording, timelapse, AI)
│   │   └── camera.js                   # Camera logic (media, recording, settings)
│   ├── css/
│   │   └── app.css                     # All styling
│   ├── icons/
│   │   ├── icon-192.svg                # App icon (192×192)
│   │   └── icon-512.svg                # App icon (512×512)
│   ├── manifest.json                   # PWA manifest
│   └── sw.js                           # Service worker (offline support)
├── package.json                        # Node dependencies (Express, WS, etc.)
├── CLAUDE.md                           # This file
└── .gitignore

```

---

**Last Updated:** May 2026 (after motion detection fix + Cancel/Back buttons + branding overhaul)
