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
- ✅ **AI model version doc drift (CLAUDE.md):** Updated coco-ssd 2.2.2 → 2.2.3 in tech stack.
- ✅ **Repo structure references non-existent CamNetService.kt (CLAUDE.md):** Replaced with `SignalingService.kt` and `StreamingService.kt`.
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

### Fixed (v1.79 — Blank room code / LAN IP not detected on Android)
- ✅ **Root cause: viewer.html redirect navigated from localhost to LAN IP, breaking SSL (viewer.html):**
  - The inline redirect script (opens `https://LAN_IP:3443` when on localhost) was causing viewer.js `fetch('/api/info')` and WebSocket to connect to the LAN IP. The self-signed cert is only trusted for `localhost` via NSC — not for the LAN IP — so both JS fetch and WS SSL failed silently, leaving room code blank.
  - Fix: skip the redirect when `window.AndroidBridge` is present. viewer.js already fetches `/api/info` independently and uses the LAN IP only for the QR URL, without redirecting the page.
- ✅ **Silent fetch failure hid the error (viewer.js):**
  - `.catch(() => {})` swallowed fetch errors with no feedback.
  - Now shows "⚠ Could not detect LAN IP — use session code only" in the session panel, logs to `crash_report.txt` via `logDiagnostic`, and still calls `connectWS()` so the room code appears regardless.

### Fixed (v1.74 — Samsung mic unavailable on connect)
- ✅ **5-tier getUserMedia audio fallback (camera.js `initMedia()`):**
  - T1: `{echoCancellation:true, noiseSuppression:true}` (ideal)
  - T2: `audio:true` (device chooses processing)
  - T3: separate `getUserMedia({video})` + `getUserMedia({audio:true})` calls — avoids combined-constraint rejection on Samsung
  - T4: `{audio:{sampleRate:16000}}` minimal constraints
  - T5 (video-only fallback): if all audio tiers fail, stream without audio, show toast, set `micEnabled=false`
  - Each failure reason captured and logged to console + `crash_report.txt` via `AndroidBridge.logDiagnostic`
- ✅ **150ms permission propagation delay (camera.js `startJoin()`):** Added before `initMedia()` call. Android WebView on some Samsung devices lags permission state by ~1 event loop tick after `onPermissionRequest` grants access.
- ✅ **`AndroidBridge.logDiagnostic(message)` (AndroidBridge.kt):** Appends timestamped entry to `crash_report.txt` and writes to logcat. Used by camera.js to surface `getUserMedia` failure reasons in the next shared crash report.
- ✅ **FIX 3 confirmed:** `StreamingService` already has `foregroundServiceType="camera|microphone"` and `RECORD_AUDIO` is in `requestPermissions()` — no change needed.

### Fixed (v1.73 — Sprint 4A Security hardening)
- ✅ **8-char room code with SecureRandom (CamNetServer.kt + server.js):** `roomCode()` now uses `SecureRandom` (Kotlin) / `crypto.randomInt` (Node) with custom alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (omits O/0/I/1 for readability). 32⁸ ≈ 1.1 trillion combinations.
- ✅ **Join nonce (all files):** `sessionSecret()` generates 128-bit hex nonce per room. Included in `room-created`/`room-rejoined` messages. Viewer stores as `roomNonce`, includes in QR/share URL as `?nonce=HEX`. Camera reads from URL, sends in `join-room`. Server rejects with `BAD_TOKEN` if nonce missing or wrong.
- ✅ **Rate limiting (CamNetServer.kt + server.js):** 10 join attempts per IP per 60 s. Rejected with `RATE_LIMITED`. Stale entries cleaned every 5 min via `cleanupScope` (Kotlin) / `setInterval` (Node). Camera stops retrying on rate limit or bad token.
- ✅ **Optional session password (viewer.html + viewer.js + camera.html + camera.js):** Viewer sets password in Settings → Security panel. Hashed via `crypto.subtle.digest('SHA-256')`, sent as `set-password`. Camera always shows password field; hash included in `join-room`. Server uses `timingSafeEqual` (Node) to compare. Off by default.
- ✅ **Security section added to CLAUDE.md:** Threat model, protection layers, limitations, WAN requirements.

### Fixed (v1.72 — Motion alert notification controls)
- ✅ **Alert sound toggle (viewer.html + viewer.js):** Settings panel "Motion Alerts" section. Persisted as `alertSound`. Passed to `AndroidBridge.fireMotionAlert` as `playSound`; notification built with `DEFAULT_SOUND` only when true.
- ✅ **Alert vibration toggle:** Same section, persisted as `alertVibration`, passed as `vibrate`; notification built with `DEFAULT_VIBRATE` only when true.
- ✅ **Alert cooldown segmented control (10s | 30s | 1m | 5m):** Replaces hardcoded 8s constant. Persisted as `alertCooldown` (seconds). Per-camera cooldown uses `alertCooldown * 1000` ms. Default 30s.
- ✅ **Per-camera 🔔 button on each camera card:** Toggles `alertCam_{cameraId}` in localStorage. When OFF, motion still shows on-screen indicator but `fireNativeMotionAlert` returns early. Button shows `.active` (highlighted) when notifications are muted for that camera. State restored on stream attach.
- ✅ **`AndroidBridge.fireMotionAlert` signature updated:** Now accepts `playSound: Boolean, vibrate: Boolean` from JS. Notification defaults controlled by these flags.

### Fixed (v1.71 — SW cache bust, Android 13+ back navigation, back button)
- ✅ **Stale service worker cache (public/sw.js):**
  - Cache version bumped `camnet-v8` → `camnet-v9`. `skipWaiting()` already present in install handler.
  - Activate handler now posts `{ type: 'SW_UPDATED' }` to all open window clients after old caches are deleted.
  - `viewer.js` and `camera.js` both listen for `SW_UPDATED` and call `location.reload()` so fresh assets load automatically without manual refresh.
- ✅ **Back gesture broken on Android 13+ (MainActivity.kt):**
  - Replaced deprecated `onBackPressed()` override with `onBackPressedDispatcher.addCallback()` using `OnBackPressedCallback`. Fires correctly for both hardware back button and gesture swipe-back on Android 13/14. Logic unchanged: `canGoBack()` → `goBack()`, else `showHome()`.
- ✅ **`goHome()` JavascriptInterface added (AndroidBridge.kt):**
  - `AndroidBridge.goHome()` calls `showHome()` on the UI thread. Setup screen already has a back button (`resetServer()`); `goHome()` is available for screens that want to navigate home without clearing the saved server URL.

### Fixed (v1.70 — Motion detection overhaul + native push notifications)
- ✅ **Settings panel toggles show wrong state on open (viewer.js):**
  - All six toggles (`globalMotionToggle`, `motionAutoSnapToggle`, `motionFlashToggle`, `smartDetectionToggle`, `muteAllToggle`, `mirrorToggle`) now sync to current variable state via `classList.toggle('on', value)` before `openPanel()` fires.
  - Removed redundant `Notification.requestPermission()` from settings open handler — native notifications bypass the Web Notification API entirely.
- ✅ **Motion detection false positives (viewer.js):**
  - **Temporal smoothing:** alert only fires after `MOTION_CONSECUTIVE_REQ = 3` consecutive above-threshold frames; single-frame flickers/artifacts are ignored. `peer.motionConsecutive` counter resets on below-threshold frame and after alert fires.
  - **Tighter SENS thresholds:** `low { pixelDiff:30, fraction:0.02 }`, `mid { pixelDiff:20, fraction:0.01 }`, `high { pixelDiff:15, fraction:0.005 }` — pixel delta floor filters compression noise that rarely exceeds 15.
  - **Cooldown reduced:** `MOTION_COOLDOWN_MS` 15s → 8s.
- ✅ **Motion alerts invisible when app is backgrounded (AndroidBridge.kt + viewer.js):**
  - `AndroidBridge.fireMotionAlert(cameraName, snapshotBase64)` JavascriptInterface fires a `IMPORTANCE_HIGH` notification via Android `NotificationManager` with vibration, sound, and optional JPEG thumbnail. Works when app is backgrounded, screen is off, or user is in another app.
  - `fireNativeMotionAlert(cameraId)` in viewer.js captures a 320px JPEG snapshot from the live video and calls the bridge. Called alongside `showMotionAlert` on every alert trigger (both basic and AI-detected).
  - Added `USE_FULL_SCREEN_INTENT` permission to `AndroidManifest.xml` for heads-up on locked screen.
  - `POST_NOTIFICATIONS` already present from Sprint 1.

### Fixed (v1.63 — Tailscale / RFC 6598 IP handling)
- ✅ **"Blocked SSL from untrusted host: 100.81.68.x" toast on Tailscale devices (MainActivity.kt `isPrivateHost()`):**
  - Added RFC 6598 range `100.64.0.0/10` (CGNAT / Tailscale) to `isPrivateHost()`. `onReceivedSslError` now proceeds for Tailscale IPs.
- ✅ **Tailscale IP shown as primary in QR code instead of WiFi IP (CamNetServer.kt `localIPs()`):**
  - `localIPs()` now separates RFC1918 IPs (10.x, 172.16-31.x, 192.168.x) from 100.x CGNAT IPs and returns RFC1918 first. QR code and session URL show the WiFi address camera phones on the same network can actually reach. Falls back to all IPs if no RFC1918 address exists.

### Fixed (v1.62 — Monitor SSL definitive fix)
- ✅ **fetch() and WebSocket SSL failures on Samsung Android 14 (network_security_config.xml + AndroidBridge.kt):**
  - Root cause 1: `onReceivedSslError` only intercepts the main document SSL error on Samsung. fetch() and WebSocket SSL errors bypass it entirely → `/api/info` and the signaling WebSocket both silently failed → no room code, no IP list shown.
  - Root cause 2: `isRunning()` sets `started = true` immediately after calling `sslProxy.start()`, but SslProxy binds its port on a background thread. First `loadUrl` could fire before port 3443 was accepting connections.
  - Fix 1: Extracted CamNet's self-signed cert from `camnet-ssl.p12` → `res/raw/camnet_ssl_cert.pem`. Added as `<certificates src="@raw/camnet_ssl_cert"/>` trust anchor for localhost in `network_security_config.xml`. Android now trusts this cert at the OS level for ALL connections (main frame, fetch, WebSocket) — no `onReceivedSslError` workaround needed.
  - Fix 2: Poll loop now probes the SSL port with a real TCP socket *after* `isRunning()` is true before calling `loadUrl`. If the port isn't accepting yet, it falls through and retries.

### Fixed (v1.61 — Samsung cleartext final fix)
- ✅ **ERR_CLEARTEXT_NOT_PERMITTED on Samsung Android 14 — definitive fix (AndroidBridge.kt `startMonitor()`):**
  - Root cause: Samsung's WebView sandbox blocks `http://localhost` even as a `loadDataWithBaseURL` base URL — no HTTP to localhost is safe on Samsung Android 14.
  - Fix: Stop using HTTP entirely. SslProxy already serves HTTPS on port 3443. Poll success branch now calls `loadUrl("https://localhost:3443/viewer.html")` directly. Socket probe switched to SSL_PORT so the poll confirms the full stack (SslProxy + Ktor) is ready.
  - `localhost` was already in `isPrivateHost()` → `onReceivedSslError` already calls `handler.proceed()` for the self-signed cert.
- ✅ **`onReceivedError` diagnostics (MainActivity.kt):**
  - Now logs URL + error code to `crash_report.txt` so "Share crash report" shows exactly what failed. Toast also shows the error code.

### Fixed (v1.60 — post-Samsung field testing)
- ✅ **ERR_CLEARTEXT_NOT_PERMITTED on Samsung Android 14 (AndroidBridge.kt `startMonitor()`):**
  - Root cause: Samsung's WebView sandbox rejects the base URL passed to `loadDataWithBaseURL` even though no real network request is made — fires `onReceivedError` immediately, calling `showHome()` before the server poll completes.
  - Fix: Spinner base URL changed from `"http://localhost:$port/"` → `"file:///android_asset/"`. Viewer load changed from `loadUrl("http://localhost:$port/viewer.html")` → `assets.open("public/viewer.html")` + `loadDataWithBaseURL("http://localhost:$port/", html, ...)`. The base URL is used only for sub-resource path resolution; Samsung allows those because the page is treated as local-origin.
- ✅ **App version and branding missing from home screen (MainActivity.kt `homeHtml()`):**
  - Added `v{versionName}` read live from `PackageManager` (always matches App Info) pinned to bottom of home screen.
  - Added `© 2026 ZeroPoint IT · All rights reserved` copyright line below version.
- ✅ **No crash reporting — bugs had to be described verbally (MainActivity.kt):**
  - Added `UncaughtExceptionHandler` that saves a crash report to `filesDir/crash_report.txt` on any unhandled crash. Report includes: version, versionCode, device model, Android version, timestamp, crashing thread name, full stack trace.
  - On next launch, dialog: "CamNet crashed — Share a report?" → Android share sheet (email/Messages/etc.). Dismiss or Share both delete the file.
- ✅ **Version numbering: bumped to 1.60 (versionCode 4)**

### Fixed (Post-sprint regression fixes)
- ✅ **ERR_CLEARTEXT_NOT_PERMITTED on Monitor start (network_security_config.xml):**
  - Root cause: IP addresses are not valid `<domain>` elements in Android NSC — they are silently ignored, so the RFC1918 domain-config blocks did nothing. `http://localhost:3000/` hit the `base-config` (cleartext denied) and bounced back to home.
  - Fix: Remove all IP-based domain-config blocks. Use a single `<domain-config>` for `localhost` (cleartext + system+user trust). `base-config` keeps cleartext denied but now includes user certs; LAN SSL errors are handled in code via `isPrivateHost()` → `handler.proceed()`.
- ✅ **QR scanner "Camera access denied" (MainActivity.kt onPermissionRequest):**
  - Root cause: Setup screen loads via `loadDataWithBaseURL("file:///android_asset/")`. The resulting `getUserMedia` call arrives with origin `"file://"` or `"null"` — neither passes `isPrivateHost()` — so the camera was denied.
  - Fix: `onPermissionRequest` now grants requests from `file://`, `data:`, `"null"`, or empty origins (all are local/asset-loaded pages) in addition to private-IP hosts.
- ✅ **"Camera (also this phone)" phantom button (MainActivity.kt + AndroidBridge.kt):**
  - Root cause: Server stayed running after `ERR_CLEARTEXT_NOT_PERMITTED` bounce; `homeHtml()` rendered the third button. Once Bug 1 is fixed the button stops appearing, but the UX is inherently confusing (tapping it swaps Monitor UI for Camera UI on the same device).
  - Fix: Removed `serverRunning`/`localCameraBtn` from `homeHtml()`. Removed `startLocalCamera()` from `AndroidBridge.kt`. Home screen always shows exactly 2 buttons.

### Fixed (Sprint 2 — commit 06fd104)
- ✅ **MAX_CONNECT_ATTEMPTS not enforced on WS close (camera.js):**
  - ws.onclose retried indefinitely; now checks `connectAttempts >= MAX_CONNECT_ATTEMPTS` and calls `giveUpAndReturnToSetup` before scheduling next retry
- ✅ **Camera names recycle after reconnect (CamNetServer.kt + viewer.js):**
  - Was `cameras.size + 1` — if Camera 1 left, next join got "Camera 1" again, causing name collisions
  - Fix: `AtomicInteger cameraCounter` on Room (server), `cameraCounter` int in viewer.js
- ✅ **runBlocking in TimerTask blocks thread pool (CamNetServer.kt):**
  - Replaced with `cleanupScope.launch {}` (CoroutineScope + SupervisorJob + Dispatchers.IO); scope cancelled in `stop()`
- ✅ **Service worker no cache cap / bad offline fallback (sw.js):**
  - Added `trimCache()` (max 50 entries) called after every `cache.put`
  - Offline fallback now returns a proper 503 Response instead of `undefined`
- ✅ **mediaBusy races (camera.js):**
  - `initMedia()` guarded by `mediaBusy` flag with try/finally reset
  - `flipCamera()` and quality list click bail early when `mediaBusy` is set
- ✅ **Notification.requestPermission spams per-camera start (viewer.js):**
  - Moved from `startMotion()` (fires once per camera per session) to `settingsBtn` click handler (fires once total on first settings open)

### Fixed (Sprint 1 — commit df32d96)
- ✅ **Android WebView :hover permanently latches camera controls:**
  - Removed `:hover` from `.cam-controls` visibility rule; controls now show/hide via JS-driven `.show-controls` class only
- ✅ **Camera bottom controls bar wraps to two rows on narrow phones:**
  - `.cam-bottom-row`: `flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch`
- ✅ **Monitor header overflows on small screens:**
  - Header: `overflow: hidden`; brand/badge/ws-status get `flex-shrink: 1`; icon-btn gets `flex-shrink: 0`; `#wsStatusText` gets `overflow: hidden; text-overflow: ellipsis`
- ✅ **Inactive camera control buttons invisible (hard to discover):**
  - `.cam-controls .icon-btn:not(.active) { opacity: 0.55 }`
- ✅ **Motion detection off by default:**
  - `globalMotion` default changed `false` → `true`; `attachStream()` always calls `startMotion()`
- ✅ **Stealth mode not bidirectional (4 bugs):**
  - Monitor sends `stealth-toggle`; camera toggles enterStealth/exitStealth based on current state; camera reports `stealth` field in `sendStatus()`; monitor tracks `peer.stealth` and keeps 🥷 button `.active`
- ✅ **Timelapse OOM with unlimited frames:**
  - Hard cap at 1000 frames; warning toast at 800
- ✅ **ontrack uses wrong stream (viewer.js):**
  - `attachStream(cameraId, e.streams[0])` → `attachStream(cameraId, peer.stream)` (merged stream)
- ✅ **handleOffer retry swallows errors silently:**
  - Second failure caught with toast: "Camera reconnect failed"
- ✅ **Settings not persisted across sessions (viewer.js):**
  - `lsSave`/`lsLoad` helpers with `camnet.viewer.` namespace; all settings (motion, sens, mute, mirror, layout, quality, smart detection, smart classes) rehydrated on load and saved on every change
- ✅ **Ping interval duplicates if WS reconnects (viewer.js):**
  - `startPing`/`stopPing` guards; `pingIntervalId` prevents double-interval
- ✅ **WebView security — SSL and media permissions too permissive (MainActivity.kt):**
  - `onReceivedSslError`: only `proceed()` for private IPs, otherwise `cancel()` + toast
  - `onPermissionRequest`: only `grant()` for private-IP origins, otherwise `deny()`
  - `isPrivateHost()` helper validates RFC1918 + loopback
  - Removed `allowFileAccessFromFileURLs` / `allowUniversalAccessFromFileURLs`
  - `mixedContentMode`: `ALWAYS_ALLOW` → `COMPATIBILITY_MODE`; added `LOAD_NO_CACHE`
- ✅ **network_security_config.xml too broad:**
  - Replaced wildcard base-config with scoped domain-config blocks for localhost/127.0.0.1 and RFC1918 ranges; base-config now denies cleartext and trusts system certs only

### Fixed (Earlier)
- ✅ **Motion detection silent failure:** `!smartDetectionEnabled || !cocoModel` fallback so basic alert fires when AI model unavailable
- ✅ **No cancel on camera live screen:** "← Cancel" on setup screen + "‹" back button on live screen, both call `hangup()`
- ✅ **Camera controls hidden tap zone:** opacity:0 + pointer-events:none on `.cam-controls`
- ✅ **Connection duplicate cards on reconnect:** `onCameraJoined` closes existing peer before creating new one
- ✅ **QR scanner hidden after Monitor→Back→Camera:** Check inside `startScan()` not at declaration
- ✅ **Fullscreen button non-functional:** CSS `.cam-fullscreen` (position:fixed, inset:0, z-index:9000)

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
| Server | Kotlin (Ktor/CIO) |
| Android | Kotlin, WebView, AndroidBridge (JavascriptInterface) |
| Web (Monitor/Camera) | HTML5, Vanilla JS, WebRTC, MediaRecorder |
| Styling | CSS Grid, flexbox |
| AI | TensorFlow.js 4.21.0 + COCO-SSD 2.2.3 (lite_mobilenet_v2) |
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

### Persistence
- ✅ Monitor settings persisted via `lsSave`/`lsLoad` (namespace `camnet.viewer.`): globalMotion, motionSens, muteAll, mirrorFront, currentLayout, photoQuality, smartDetectionEnabled, smartClasses
- Camera name optional; no persistent phone identity

---

## Future Enhancements (Not Implemented)

- [ ] Person detection with face recognition (privacy-local)
- [ ] Geofencing trigger (location-based alerting)
- [ ] Custom motion zones per camera (drawn polygons)
- [ ] 24/7 DVR mode (rolling buffer, search by time)
- [ ] Two-way audio (mic from Monitor phone to Camera)
- [ ] Night vision mode (IR LED control, if supported)
- [ ] Cloud backup (optional, user-controlled)

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

### Deferred
- Encrypted-at-rest snapshots/recordings (key management + viewing flow changes) — Sprint 5

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
├── package.json                        # Node dependencies (Express, WS, etc.)
├── CLAUDE.md                           # This file
└── .gitignore

```

---

**Last Updated:** May 2026 (v1.79 — blank room code fix, LAN IP redirect suppressed on Android)
