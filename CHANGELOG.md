# CamNet Changelog

Historical fix log. Active patterns to watch are kept in CLAUDE.md under "Known Issues & Fixes" (last 10 builds). Anything older lives here.

Versioning: each entry header uses the actual APK `versionName`, which is `1.{CI_build_number}`.

---

### Fixed (v1.90 — SSL BLOCKED log, mic NotReadableError no longer blocks join)
- ✅ **`isPrivateHost` confirmed correct:** `(parts[0]==192 && parts[1]==168)` covers full 192.168.0.0/16 — 192.168.137.x passes with no change needed.
- ✅ **`onReceivedSslError` blocked path now logs (MainActivity.kt):** Added `Log.e("CamNet", "SSL BLOCKED for '$urlHost'...")` so the blocked case is unambiguous in logcat.
- ✅ **`NotReadableError` on mic no longer blocks camera join (camera.js `initMedia()`):** When all audio tiers fail AND the video-only call also fails (hardware locked), instead of throwing (which aborts the join), logs a warning, shows a toast, sets `micEnabled=false`, `localStream=null`, and returns normally. `connectWS()` still runs. Guard added in `createPeer()` — `if (localStream)` before `addTrack` so null stream doesn't crash.

### Fixed (v1.89 — onLoadUrl logging + SSL error diagnostics)
- ✅ **`onLoadUrl` was a silent anonymous lambda (MainActivity.kt):** Extracted into named `onLoadUrl(url: String)` function with `Log.i` on entry and `Log.e` + Toast on exception. `AndroidBridge` now wired via `::onLoadUrl` reference.
- ✅ **`onReceivedSslError` used `java.net.URL` for host extraction (MainActivity.kt):** `URL` throws on non-HTTP schemes and strips brackets from IPv6. Switched to `java.net.URI` which handles all URL forms. Added `Log.w` line showing `urlHost trusted=true/false` for every SSL event — visible in logcat without USB adb grep.

### Fixed (v1.86 — JS TDZ crash + WebSocket plain-port bypass)
- ✅ **`alertSound` used before initialization — JS crashes on load (viewer.js):** `let alertSound/alertVibration/alertCooldown` were declared at line ~1019 but assigned via `lsLoad()` at line 129 (temporal dead zone). Moved all three declarations to the top of the file alongside the other settings variables, before any code runs.
- ✅ **WebSocket SSL cert invalid on Samsung — `wss://localhost:3443` fails (AndroidBridge.kt + viewer.js):** p12 cert is unchanged (confirmed identical). Root cause: Samsung WebView's JS network stack doesn't trust NSC cert anchors for JS-initiated WebSocket connections. Fix: Kotlin passes `wsport=PORT` in the URL fragment alongside `lan=IP`. viewer.js uses `ws://localhost:PORT` (plain, no SSL) when `wsport` is present and `AndroidBridge` is defined. Chrome/WebView allows `ws://localhost` from `https://` pages via the localhost mixed-content exemption — no cert needed.

### Fixed (v1.85 — auto-sync SSL cert + WS diagnostics)
- ✅ **Stale pinned cert causing WSS failure (build.gradle):** Added `extractSslCert` Gradle task that reads `camnet-ssl.p12`, extracts the current cert, and writes `res/raw/camnet_ssl_cert.pem` at build time. Wired via `preBuild.dependsOn extractSslCert` (same pattern as `copyWebAssets`) so it always runs before compilation. Cert in NSC trust anchor now always matches what the server actually presents.
- ✅ **WebSocket diagnostic logging (viewer.js `connectWS()`):** Logs URL, open, close (code+reason), and error events to `logDiagnostic` (→ `crash_report.txt`) and console. On WS error, shows `WS-ERR` in the session code box so failures are visible without USB debugging.

### Fixed (v1.84 — bypass Samsung fetch() SSL bug for LAN IP detection)
- ✅ **Root cause: Samsung WebView fetch() has a separate SSL validation path that ignores NSC cert anchors (known Samsung bug).** fetch('/api/info') silently fails → no LAN IP → no QR → session code blank (WS only called after fetch chain, so also fails).
- ✅ **Fix: Kotlin passes LAN IP in URL fragment (AndroidBridge.kt + CamNetServer.kt):** After SSL port probe, `CamNetServer.getLanIP()` (new companion object function) gets the best RFC1918 IP. `loadUrl("https://localhost:3443/viewer.html#lan=192.168.x.x")` passes it without any fetch.
- ✅ **viewer.js boot rewritten:** Reads `#lan=IP` from fragment first. If present, sets `window._lanIP`, shows IP in session panel, calls `connectWS()` immediately — no fetch. If no fragment (browser / non-Samsung), falls back to `fetch('/api/info')` as before.

### Fixed (v1.81 — Four UX and connection fixes from v1.79 testing)
- ✅ **Session code blank on monitor (AndroidBridge.kt `startMonitor()`):** Replaced `loadUrl("https://localhost:$sslPort/viewer.html")` with `loadDataWithBaseURL("https://localhost:$sslPort/", html, ...)` where html is read from assets. No SSL handshake required for main frame; fetch and WebSocket still resolve to `https://localhost:3443/` (covered by NSC cert trust).
- ✅ **FIX 2 confirmed: `showCameraSetup()` → `showSetup()` already correct.** No change needed.
- ✅ **Password UX (viewer.html + viewer.js + camera.html + setupHtml + AndroidBridge.kt):**
  - Plaintext stored in `_sessionPasswordPlain` in viewer.js; toast says "share it with camera users manually"; 📋 copy button added next to Set button in settings panel.
  - camera.html password placeholder: "Leave blank if none" → "Ask the monitor user".
  - setupHtml (Kotlin): password input added; `connect()` calls `AndroidBridge.setPendingPassword(pw)` before `setServerUrl`.
  - `AndroidBridge.setPendingPassword/getPendingPassword`: stores/clears plaintext in SharedPreferences so camera.js can pre-fill `#passwordInput` after camera.html loads (camera.js hashes it on join).
- ✅ **Code input placeholder (camera.html):** `XXXXXXXX` → `8-CHAR CODE`. `autocapitalize="characters"` and `maxlength="8"` already present.

### Fixed (v1.80 — Auto-update via GitHub Releases)
- ✅ **GitHub Actions workflow creates Releases (build-apk.yml):** Each successful build now publishes a tagged GitHub Release (`v{run_number}`) with the APK attached. `GITHUB_TOKEN` used automatically — no extra secrets needed.
- ✅ **Version check on launch (MainActivity.kt `checkForUpdate()`):** Background thread hits `api.github.com/repos/.../releases/latest`, compares `tag_name` (strip `v`, parse int) against `BuildConfig.VERSION_CODE`. Silent on network failure (5s timeout). Shows `AlertDialog` if newer version found.
- ✅ **Download + install (MainActivity.kt `downloadAndInstall` + `promptInstall`):** Uses `DownloadManager` to fetch APK to `Downloads/`, polls for completion, then triggers install via `FileProvider` URI with `ACTION_VIEW`.
- ✅ **FileProvider (AndroidManifest.xml + res/xml/file_provider_paths.xml):** `${applicationId}.provider` authority; external `Download/` path exposed for install URI.
- ✅ **Permissions added:** `REQUEST_INSTALL_PACKAGES`, `WRITE_EXTERNAL_STORAGE` (maxSdk 28).
- ✅ **build.gradle:** `buildFeatures { buildConfig true }` so `BuildConfig.VERSION_CODE` compiles; added `androidx.activity:activity-ktx:1.8.2` (fixes `OnBackPressedCallback` unresolved reference from Sprint 4A).

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
