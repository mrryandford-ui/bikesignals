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
1. Monitor starts session (8-char room code, QR code, LAN IP)
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
- ✅ Motion detection: pixel-diff on downsampled canvas, polygon zone picker with point-in-polygon analysis
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
- ✅ **Auto-update:** On launch, checks GitHub Releases API; shows dialog if newer APK found. Downloads via `DownloadManager`, installs via `FileProvider`. "⬆ Check for updates" button on home screen for manual trigger.
- ✅ **Two-way audio:** Monitor mic → all connected cameras. 🎤 header button; camera plays via hidden `<audio>`, shows "🎤 MONITOR" badge when active. Uses `sendrecv` transceiver + `replaceTrack`.
- ✅ **DVR rolling buffer:** Per-camera 24/7 rolling 30-min buffer (1-min segments, 30 max). 📼 button per card; playback modal with segment list (newest first) and video player. Oldest segments auto-purged.

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

---

## Known Issues & Fixes

### Fixed (vNEXT — viewer.js TDZ crash on boot)
- ✅ **`motionAutoSnap` / `motionFlash` / `motionFlashStillMins` TDZ crash (public/js/viewer.js):** Same pattern as v1.86 alertSound/alertVibration/alertCooldown fix. v1.92 added `lsLoad()` rehydration assignments at line ~130 but forgot to hoist the corresponding `let` declarations to the top of the file. ReferenceError "Cannot access 'motionAutoSnap' before initialization" fired at boot, killing the script before `connectWS()` ran — session code displayed BLANK, no peers ever joined. Caught by runtime check on Moto G 2025 after the v1.115 Gradle bump. Fix: moved all three `let` declarations to the top settings block.
- ✅ **Versioning convention enforced:** changelog entry headers MUST use the actual APK `versionName` (`1.{CI_build_number}`). v1.94 and v1.95 labels were logical placeholders and have been corrected to their actual versionNames (v1.113 and v1.115).
- ✅ **CLAUDE.md slimmed:** all "Fixed" entries older than the 10 most recent builds moved to CHANGELOG.md. "Future Enhancements" and "Deferred" lists moved to ROADMAP.md. "Branding" ship-state checklist deleted (static, not actionable). Operational sections (Tech Stack, Security, Development Notes, Repo Structure, Testing Checklist, CI/Deployment) retained.

### Fixed (v1.115 — Gradle 9.1.0 → 9.5.1 patch bump)
- ✅ **Gradle 9.1.0 → 9.5.1 (build-apk.yml):** Current stable Gradle 9.x. AGP 9.0.1 supported through Gradle 9.5.x per Gradle compatibility matrix (tested through AGP 9.2.0-alpha05). 9.5.1 adds task provenance to error messages — failure messages now include "registered by plugin X" so failed task sources are traceable. Also includes automatic Wrapper download retry and numerous R8 and config-cache fixes vs 9.1.0. CI-only change; no Gradle build script changes required.

### Fixed (v1.113 — AGP 9.0.1 + Gradle 9.1.0 migration)
- ✅ **AGP 8.11.0 → 9.0.1 (android/build.gradle):** Major version upgrade. AGP 9.0 requires Gradle 9.1.0 minimum and build-tools 36.0.0. AGP 8.9.0 and 8.11.0 were tried first but both fail with Gradle 8.14.1 due to internal Gradle API removals in 8.7+ and 8.13+ respectively; the correct fix was upgrading both AGP and Gradle together.
- ✅ **Gradle 8.14.1 → 9.1.0 (build-apk.yml):** Minimum required for AGP 9.0.1.
- ✅ **build-tools 36.0.0 added to CI (build-apk.yml):** AGP 9.0 requires build-tools 36.0.0 for D8/R8/aapt2.
- ✅ **AGP 9.0 builtInKotlin — dropped explicit KGP plugin (android/build.gradle + app/build.gradle):** AGP 9.0 defaults `builtInKotlin=true` and manages Kotlin compilation internally. Applying `org.jetbrains.kotlin.android` alongside it causes a build conflict. Fix: removed both `id 'org.jetbrains.kotlin.android'` declarations and removed `kotlinOptions { jvmTarget = '17' }` — AGP 9.0 infers jvmTarget from `compileOptions.targetCompatibility = VERSION_17` automatically. No separate KGP version pin is needed; AGP 9.0 bundles Kotlin 2.2.10.
- ✅ **`task copyWebAssets(type: Copy)` → `tasks.register('copyWebAssets', Copy)` (app/build.gradle):** Gradle 9.x removed the eager `task name(type: X)` creation syntax. Lazy registration via `tasks.register` is required.
- ✅ **`afterEvaluate { preBuild.dependsOn ... }` → `tasks.named('preBuild').configure { ... }` (app/build.gradle):** AGP 9.0 creates `preBuild` as a lazy task; direct property access inside `afterEvaluate` fails. `tasks.named()` defers the lookup until the task is actually registered.
- ✅ **Removed `android.enableJetifier=true` (gradle.properties):** Jetifier is unsupported in AGP 9.0; all dependencies are already AndroidX so no translation is needed.
- ✅ **Removed `org.gradle.configuration-cache=true` (gradle.properties):** Gradle 9.x enforces configuration cache strictly. The `afterEvaluate` block is configuration-cache-incompatible; removing the opt-in avoids the conflict.

### Fixed (v1.93 — Kotlin 2.1.21 + Gradle 8.14.1 + AGP 8.11.0 + Ktor 3.1.3 migration + compileSdk 35 + responsive UI)
- ✅ **Kotlin 1.9.22 → 2.1.21 (K2 compiler) (android/build.gradle):** K2 is backward-compatible; required to read Kotlin 2.x metadata from newer AndroidX libs (activity-ktx 1.10.1, core-ktx 1.16.0 are compiled with Kotlin 2.x — using them with Kotlin 1.9 causes "incompatible metadata" compile errors).
- ✅ **Gradle 8.2.1 → 8.14.1 (build-apk.yml):** AGP 8.2.2 tops out at Gradle 8.6; 8.14.1 needed for K2 Gradle plugin improvements.
- ✅ **AGP 8.2.2 → 8.11.0 (android/build.gradle):** AGP 8.2.2 uses internal Gradle APIs removed in 8.7+. AGP 8.9.0 predates Gradle 8.13 and also fails. AGP 8.11.0 minimum Gradle is 8.13 — the first AGP built and tested against the 8.13–8.14 range. CI sdkmanager step updated to also install `platforms;android-35` and `build-tools;35.0.0`.
- ✅ **compileSdk/targetSdk 34 → 35 (app/build.gradle):** Required by AGP 8.11+; Android 15 is the current baseline. Edge-to-edge enforcement on targetSdk 35 is handled by `hideSystemBars()` (already hides all bars) and the v1.93 safe-area-inset CSS.
- ✅ **Removed `inputs.file()` from `extractSslCert` Gradle task (app/build.gradle):** Gradle 8.14 enforces stricter task input declaration validation; file existence is already checked defensively inside `doLast`.
- ✅ **Ktor 2.3.7 → 3.1.3 (app/build.gradle + CamNetServer.kt):** Fixes CVE-2025-29904 HTTP request smuggling. Breaking API: `java.time.Duration` → `kotlin.time.Duration.Companion.seconds` for `pingPeriod`/`timeout` in `install(WebSockets)`. All other CamNetServer.kt API (embeddedServer, routing, webSocket, DefaultWebSocketSession) is stable across 2.x→3.x.
- ✅ **AndroidX bumps (app/build.gradle):** appcompat 1.6.1→1.7.1, core-ktx 1.12.0→1.16.0, activity-ktx 1.8.2→1.10.1.

### Fixed (v1.93 — responsive UI overhaul + in-app navigation fix)
- ✅ **Responsive layout: small phone to large tablet (app.css + all HTML files):**
  - `viewport-fit=cover` added to viewport meta in `index.html`, `viewer.html`, `camera.html` — required for `env(safe-area-inset-bottom)` to report correctly on notched/gesture-bar devices.
  - `100dvh` added alongside `100vh` fallback in `.viewer-app`, `.camera-app`, `.home-page` — fixes layout when mobile browser chrome collapses/expands.
  - `.room-code` `min-width: 220px` removed — was overflowing 320px screens. Font replaced with `clamp(26px, 8vw, 38px)` and letter-spacing with `clamp(3px, 1.2vw, 6px)`.
  - `.cam-bottom-bar` and `.setup-screen` bottom padding use `max(Npx, calc(12px + env(safe-area-inset-bottom)))` — clears gesture indicator on iPhone/Android.
  - `.panel-sheet` bottom padding uses `max(40px, calc(20px + env(safe-area-inset-bottom)))`; added `overscroll-behavior: contain`.
  - `.setup-screen` gains `overflow-y: auto` and `overscroll-behavior: contain` so the form stays reachable when the keyboard opens on short phones.
  - **xs ≤374px:** viewer header icon buttons shrink to 30px; ws status text hidden (dot retained); cam count badge hidden; seg-ctrl rows wrap (label above, control full-width); seg-btn font/padding reduced; camera live control icons 38px; l-2 grid collapses to 1 col.
  - **sm ≤479px:** session actions stack vertically; live status bar tighter; home page padding reduced.
  - **lg ≥600px:** panel sheets capped at 520px and horizontally centered (`.panel { justify-content: center }`); home role cards go side-by-side; feed grid uses 260px minimum cell.
  - **xl ≥768px:** viewer header 56px tall; camera live controls 54px icons; feed grid 300px minimum cell; setup form wider; panel sheet capped at 560px.
  - **2xl ≥1024px:** feed grid 360px min cells; home logo/title scale up; panel sheet capped at 600px.
  - **Landscape phone (height ≤500px):** setup title hidden to save vertical space; live screen rotates to row layout with controls in a vertical sidebar.
  - Service worker cache bumped `camnet-v10` → `camnet-v11` to force immediate asset refresh.
- ✅ **Back button from Monitor viewer lands on wrong home screen (viewer.html):**
  - Root cause: `<a href="/">‹</a>` navigated the WebView to the Ktor server root, which served `public/index.html` — a static file with no version info or native home screen content. The Kotlin-generated `homeHtml()` (which has version, copyright, update button) was never shown.
  - Fix: Replaced anchor with `<button id="homeBtn">` that calls `AndroidBridge.goHome()` when running inside the app (triggers the native `showHome()` → `homeHtml()`); falls back to `location.href='/'` in a browser context.

### Fixed (post-v1.92 — back navigation + CI hardening)
- ✅ **Back from Monitor viewer lands on spinner, not home (MainActivity.kt + AndroidBridge.kt):**
  - Root cause: `startMonitor()` loads a "Starting server…" spinner page before `loadUrl(viewer.html)`. WebView history was `[home → spinner → viewer.html]`; `canGoBack()` returned true so pressing back surfaced the spinner, not home.
  - Fix 1: `handleOnBackPressed` checks `webView.url.startsWith("https://localhost")` — if true, calls `showHome()` directly, skipping the stale spinner in back-stack.
  - Fix 2: `AndroidBridge.startMonitor()` calls `activity.webView.clearHistory()` before `loadUrl(viewer.html)` so the spinner is pruned from history at the source.
  - Camera flow (setup → camera.html → back → setup) unaffected — camera URLs use LAN IP, not localhost.
- ✅ **CI: GitHub Release step failed with 403 (build-apk.yml):**
  - Root cause: `softprops/action-gh-release@v2` needs `contents: write`; GitHub Actions defaults to read-only token for newer repos.
  - Fix: Added `permissions: contents: write` at the job level.
- ✅ **CI: `extractSslCert` Gradle task caused AGP 8.2.x build failure (build.gradle):**
  - Root cause: `tasks.configureEach` inside `afterEvaluate` forces all lazy AGP tasks to realize eagerly, breaking AGP's internal configuration order.
  - Fix: Replaced the `configureEach` block with `preBuild.dependsOn extractSslCert` — same pattern as `copyWebAssets`, runs before all compile tasks.

### Fixed (pre-v1.92 — connection, update, and UI fixes)
- ✅ **Join URL missing `/camera.html` after QR scan (AndroidBridge.kt `openCameraFromQR`):**
  - Built `$base/camera.html$query` correctly; previous code omitted the path segment.
  - Added `window._navigatingAway` flag in setupHtml so fast double-taps can't fire two navigations.
- ✅ **Service worker cached `camera.html?room=X&nonce=Y` without query params (sw.js):**
  - Network-first bypass added for any URL with query params — prevents stale cached page returning without room/nonce.
  - Cache version bumped to v10.
- ✅ **Nonce/room params stripped from camera.html URL during WebView navigation (AndroidBridge.kt):**
  - Android WebView was silently dropping query params on `loadUrl`. Fixed by verifying URL construction and adding diagnostic logging (`Log.i`) at `onLoadUrl` entry.
- ✅ **Self-signed cert not trusted for LAN IP connections (network_security_config.xml):**
  - Added cert pin for all domains (not just localhost) so camera phones on LAN connecting to `https://192.168.x.x:3443` pass cert validation without a browser warning.
- ✅ **`promptInstall` crashed / silently failed on 0-byte APK (MainActivity.kt):**
  - Added `file.exists() && file.length() > 0` guard before `FileProvider.getUriForFile`. Added `Log.i` with file path and size so download failures are visible in logcat.
- ✅ **Password input in Kotlin setupHtml expanded to fill screen (MainActivity.kt):**
  - Input had no height constraint inside a flex column — added `flex:none` inline style.
- ✅ **No manual update trigger on home screen (MainActivity.kt + AndroidBridge.kt):**
  - Added "⬆ Check for updates" button to `homeHtml()`, wired to `AndroidBridge.checkForUpdateManual()`.
  - `checkForUpdateManual()` JavascriptInterface added — shows a toast first, then calls `checkForUpdate(manual=true)` for user-visible error feedback.
- ✅ **Update version compare broken + APK install failed on Moto G (MainActivity.kt):**
  - Version compare was comparing strings instead of ints — `"9" > "10"` was true. Fixed to parse int before compare.
  - Moto G stores downloads in a different path; switched to `getExternalFilesDir(DIRECTORY_DOWNLOADS)` which is app-specific and always writable.
- ✅ **Motion detection `globalMotion` default wrong + card/panel out of sync (viewer.js):**
  - `globalMotion` was defaulting to `false` despite Sprint 1 intent to default ON. Corrected to `true`.
  - Motion button on camera card and settings panel toggle were not keeping each other in sync on open — fixed bidirectional sync.
- ✅ **QR nonce dropped from camera.html URL + missing join diagnostics (AndroidBridge.kt + viewer.js):**
  - Nonce was not appended to the `camera.html` destination URL built in `openCameraFromQR`. Fixed.
  - Added `Log.i` for room/nonce values at QR parse time so join failures are traceable without USB adb.

### Fixed (v1.92 — Two-way audio, DVR, polygon zones, motion alert regressions)
- ✅ **Settings not fully rehydrated from localStorage on boot (viewer.js):**
  - `motionAutoSnap`, `motionFlash`, `motionFlashStillMins` were declared but never loaded via `lsLoad` — values always reset to defaults on page reload. Added all three `lsLoad` calls at boot.
  - `globalMotion` default corrected `false` → `true` (Sprint 1 set it to true but a later edit regressed it).
  - Settings panel open handler now also syncs `motionFlashStillRow` visibility, segment control active buttons, and smart detection rows — previously stale toggles on re-open.
  - Boot-time UI restoration added for `motionFlashStillRow`, `smartDetectionStatusRow`, `smartClassesRow`.
- ✅ **Two-way audio (viewer.js + camera.js + viewer.html + camera.html):**
  - Monitor: `getUserMedia({audio:true})` → `replaceTrack()` on each peer's audio send transceiver. `🎤` button in header toggles mic. `monitorAudioStream` + `monitorMicEnabled` track state.
  - Per-peer `audioSendTransceiver` stored after SDP negotiation via `_storeAudioSendTransceiver()`. New peers inherit live mic track if mic is active.
  - Camera: `offerToReceiveAudio: true` in createPeer(), `pc.ontrack` plays incoming audio via hidden `<audio id="monitorAudio">`. "🎤 MONITOR" badge shows/hides on track mute/unmute events.
  - Transceiver direction changed from `recvonly` → `sendrecv` for the audio transceiver in viewer.js.
- ✅ **DVR rolling buffer (viewer.js):**
  - `startDvr(cameraId)` / `stopDvr(cameraId)` / `_startDvrSegment(cameraId)`: 1-min MediaRecorder segments on received stream. Auto-chains via `onstop`. Purges oldest when >30 segments (`DVR_SEGMENT_MS = 60_000`, `DVR_MAX_SEGMENTS = 30`).
  - `openDvrPlayback(cameraId)`: modal with video player + segment list newest-first. Object URLs created on demand; modal cleanup revokes them to avoid memory leaks.
  - 📼 per-camera button in card controls row.
- ✅ **Polygon motion zones (viewer.js):**
  - `openZoneEditor` rewritten: click-to-add-vertices SVG editor. Tap near ① (first vertex, 3+ points) to close polygon. Undo button removes last vertex. Pre-loads existing polygon for re-editing. Closed polygon shown filled; open path shows dashed guide line back to start.
  - `analyze()` upgraded: `zone.type === 'polygon'` branch uses `pointInPolygon()` (ray casting, O(vertices) per pixel, runs on 160×120 canvas). Legacy rect zones (`{x,y,w,h}`) fully backward-compatible.
  - `updateZoneOverlay()` upgraded: SVG `<polygon>` element for polygon zones; existing CSS div for legacy rect zones. ZONE label rendered as SVG `<text>` near first vertex.
  - Zone stored as `{ type: 'polygon', points: [{x,y},...] }` (normalized 0-1).

### Fixed (Sprint 3)
- ✅ **Quality change mid-recording breaks MediaRecorder (camera.js):**
  - Root cause: `handleCommand('quality')` called `initMedia()` which stopped the old stream; active MediaRecorder then errored.
  - Fix: `_changeQuality(value)` helper: if recording active, sets `recordActive = false`, awaits recorder onstop (saves final segment), then calls `initMedia`, replaces track, restarts recording with `_startCameraSegment`. Toast: "Quality changed mid-recording — new segment started".
- ✅ **Stale sessionStorage roomId rejoined after "New session" (viewer.js):**
  - `newSessionBtn` now calls `sessionStorage.removeItem('camnet_room')` before `create-room`.
- ✅ **Android media notification persists after hangup (camera.js):**
  - `stopKeepAlive()` now clears `navigator.mediaSession.metadata = null` after setting `playbackState = 'none'` (in try/catch for WebView compatibility).
- ✅ **Browser-side camera recording had no monitor upload fallback (camera.js):**
  - `_saveCameraSegment` now POSTs to `/api/save-video` when `AndroidBridge` is undefined, with download-link fallback if the POST fails (mirrors `_saveMonitorSegment` in viewer.js).
- ✅ **Hover rules stuck on touch (app.css):**
  - All `:hover` rules (`.role-card.viewer/camera:hover`, `.icon-btn:hover`, `.icon-btn.danger:hover`, `.btn-outline:hover`, `.panel-close:hover`, `.cam-controls .icon-btn:not(.active):hover`) wrapped in `@media (hover: hover)`.
- ✅ **CDN scripts loaded without crossOrigin (viewer.js):**
  - `loadScript` now accepts `{ integrity, crossOrigin }` options; TF.js and COCO-SSD calls pass `crossOrigin: 'anonymous'`. SRI `integrity` hash slots are present with a comment on how to compute them.
- ✅ **Timelapse render setTimeout chain blocks UI (viewer.js):**
  - `_renderTlVideo` tick loop converted from `setTimeout(tick, 1000/24)` to `requestAnimationFrame` with wall-clock frame position. Browser yields between frames; render fps stays at 24 via `canvas.captureStream(24)`.
- ✅ **recordSegNum incremented after async save — could skip on partial failure (camera.js + viewer.js):**
  - Camera: `const segNum = recordSegNum++` before `_saveCameraSegment` call.
  - Monitor: `const segNum = peer.recSegNum++` before `_saveMonitorSegment` call.
- ✅ **recChunks double-reset race in monitor recording (viewer.js):**
  - Removed `peer.recChunks = []` from inside `rec.onstop`. Only `_startMonitorSegment` top resets the array, preventing a late `ondataavailable` from a dying recorder writing into the new segment's array.
- ✅ **Public STUN servers used on LAN-only app (viewer.js + camera.js):**
  - `ICE_SERVERS = []` in both files. Camera adds 30 s fallback: if host candidates don't connect, retries `createPeer()` with STUN list. Console logs which path succeeded. Viewer handles new offer from camera retry normally.
- ✅ **No way to reset persisted settings (viewer.js + viewer.html):**
  - "Reset to defaults" button at bottom of settings panel. Confirms, then clears all `camnet.viewer.*` localStorage keys and reloads.

### Fixed (v1.91 — version auto-set from CI run number, update dialog shows versionName)
- ✅ **versionCode/versionName now driven by `GITHUB_RUN_NUMBER` in build.gradle:** Replaced hardcoded values with `def runNum = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInteger()`. Local builds use run number 1; CI builds always produce a versionCode that exactly matches the GitHub release tag. Removed the brittle `sed` step from the workflow.
- ✅ **Update dialog showed versionCode not versionName (MainActivity.kt):** Dialog now reads `versionName` from PackageManager and shows `"CamNet v1.91 is available (you have v1.90)"` instead of raw integers. `latestName` computed as `"1.$latestNum"` to match the version scheme.
- ✅ **Added `Log.i` to update check:** Logs `latest=$latestNum current=$currentNum` on every check so mismatches are visible in logcat.
- ✅ **`latestNum > currentNum` guard confirmed:** Line 121 already uses `<=` (not `<`), so dialog only appears when a newer version exists.

---

For older fixes, see [CHANGELOG.md](./CHANGELOG.md).

### Testing Checklist
- [ ] Motion detection fires in both basic and AI modes (motion on by default)
- [ ] Settings persist across app restarts (layout, motion, sens, quality, smart classes)
- [ ] Stealth mode button stays highlighted on Monitor; 3-tap exits stealth on Camera
- [ ] Camera name stays stable when camera disconnects and rejoins
- [ ] Monitor returns Camera to setup after MAX_CONNECT_ATTEMPTS failed retries
- [ ] Camera bottom bar scrolls horizontally on narrow phones (no wrap)
- [ ] Notification permission prompt appears on first Settings panel open (not on every motion start)
- [ ] Cancel button works on setup screen during connection attempt
- [ ] Back button on live screen returns to setup
- [ ] Timelapse warns at 800 frames and stops at 1000
- [ ] QR scanner accessible after navigating back from live screen
- [ ] Flash stays on for selected duration after motion
- [ ] Recording segments at 5 minutes

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Server | Kotlin 2.2.10 (bundled via AGP builtInKotlin), Ktor 3.1.3 (CIO engine) |
| Android | AGP 9.0.1 + built-in Kotlin 2.2.10, compileSdk/targetSdk 35, minSdk 29 |
| Build | Gradle 9.5.1, Java 17 (Temurin), build-tools 36.0.0 |
| Web (Monitor/Camera) | HTML5, Vanilla JS, WebRTC, MediaRecorder |
| Styling | CSS Grid, flexbox, safe-area-inset, 100dvh |
| AI | TensorFlow.js 4.22.0 + COCO-SSD 2.2.3 (lite_mobilenet_v2) |
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

### CI / GitHub Actions (`build-apk.yml`)
Every push to `main` or `claude/*` branches triggers a build:
1. Java 17 (Temurin) + Android SDK 34/35 + build-tools 35.0.0/36.0.0 + Gradle 9.5.1 installed
2. Signing keystore (`camnet-debug.jks`) restored from Actions cache (generated once, reused so APK updates install without uninstalling)
3. `BUILD_NUMBER` env var set to `github.run_number`; `build.gradle` reads it via `System.getenv("BUILD_NUMBER")` — no `sed` manipulation needed
4. `gradle assembleDebug --no-daemon` builds the APK
5. APK uploaded as a workflow artifact (90-day retention)
6. GitHub Release created with tag `v{run_number}` and APK attached (`permissions: contents: write` required at job level)

### Android (local)
```bash
cd android
# No gradlew wrapper — use system gradle or Android Studio
gradle assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

### Web (Development)
```bash
npm start  # or: node public/server.js
# Server: http://localhost:3000
# Camera: https://LAN_IP:3443/camera.html
```

### Deployment Steps
1. Push to branch → CI builds APK automatically → GitHub Release published
2. Install APK on Monitor phone + all Camera phones (app auto-updates on launch)
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

### Persistence
- ✅ Monitor settings persisted via `lsSave`/`lsLoad` (namespace `camnet.viewer.`): globalMotion, motionSens, muteAll, mirrorFront, currentLayout, photoQuality, smartDetectionEnabled, smartClasses
- Camera name optional; no persistent phone identity

---

## Future Work

See [ROADMAP.md](./ROADMAP.md) for planned features and deferred items.

---

## Security

### What's Protected

| Layer | Mechanism |
|-------|-----------|
| **WebRTC media** | DTLS-SRTP — end-to-end encrypted, mandatory. Monitor server cannot read media. |
| **Signaling (LAN)** | TLS via SslProxy — self-signed cert, acceptable for LAN. Requires real cert for WAN. |
| **Room code entropy** | 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (omits O/0/I/1). 32⁸ = 1.1 trillion combinations. Generated with `SecureRandom` (Java) / `crypto.randomInt` (Node.js). |
| **Join nonce** | 128-bit hex secret generated with room. Required alongside room code to join. QR and share link carry both `?room=CODE&nonce=HEX`. Typing the 8-char code without the nonce is rejected with `BAD_TOKEN`. |
| **Rate limiting** | 10 join attempts per IP per 60 s. 11th attempt rejected with `RATE_LIMITED`. In-memory, cleaned every 5 min. |
| **Optional session password** | Viewer sets password via settings panel. Hashed client-side with SHA-256 (`crypto.subtle`). Camera must enter matching password. Server compares using `timingSafeEqual` (Node.js) / string equality (Kotlin). Off by default. |

### Current Limitations
- No 2FA
- Signaling server (this app) can read SDP offers/answers — but NOT media (that's E2E encrypted)
- Password hash is stored in-memory on server; restarts clear it
- Self-signed TLS cert; camera phones get a browser warning on first connect

### WAN Deployment (future)
Requires: real TLS cert (Let's Encrypt), TURN server (coturn / Oracle Always Free), network-level rate limiting (Cloudflare WAF or iptables), and moving signaling to a persistent host.

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
│       │   ├── SignalingService.kt      # Foreground service: runs Ktor server + WS signaling
│       │   └── StreamingService.kt     # Foreground service: keeps camera alive with screen off
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
├── CHANGELOG.md                        # Fix history (pre-v1.91)
├── ROADMAP.md                          # Planned features and deferred items
├── package.json                        # Node dependencies (Express, WS, etc.)
├── CLAUDE.md                           # This file
└── .gitignore

```

---

**Last Updated:** May 2026 (vNEXT — viewer.js TDZ fix + CLAUDE.md slim; v1.115 Gradle 9.5.1; v1.113 AGP 9.0.1 stack)
