package com.camnet.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.provider.Settings
import android.webkit.JavascriptInterface
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlin.concurrent.thread

class AndroidBridge(
    private val context: Context,
    private val onLoadUrl: (String) -> Unit,
) {
    /** Called from home screen "Check for updates" button — runs update check with user feedback. */
    @JavascriptInterface
    fun checkForUpdateManual() {
        (context as? MainActivity)?.runOnUiThread {
            android.widget.Toast.makeText(context, "Checking for updates…", android.widget.Toast.LENGTH_SHORT).show()
        }
        (context as? MainActivity)?.checkForUpdate(manual = true)
    }

    /** Appends a diagnostic message to diagnostics.txt (NOT crash_report.txt) and logcat.
     *  Writing to crash_report.txt was causing a false "app crashed" dialog on every relaunch. */
    @JavascriptInterface
    fun logDiagnostic(message: String) {
        android.util.Log.d("CamNet", "JS diagnostic: $message")
        try {
            val entry = "[${java.time.LocalDateTime.now()}] $message\n"
            java.io.File(
                (context as? MainActivity)?.filesDir ?: return,
                "diagnostics.txt"
            ).appendText(entry)
        } catch (_: Exception) {}
    }

    /** Controls the device torch LED via CameraManager — more reliable than
     *  WebView getUserMedia track.applyConstraints on MediaTek/Samsung devices. */
    @JavascriptInterface
    fun setTorch(on: Boolean) {
        try {
            val cm = context.getSystemService(android.content.Context.CAMERA_SERVICE)
                    as android.hardware.camera2.CameraManager
            val rearId = cm.cameraIdList.firstOrNull { id ->
                val chars = cm.getCameraCharacteristics(id)
                chars.get(android.hardware.camera2.CameraCharacteristics.LENS_FACING) ==
                    android.hardware.camera2.CameraCharacteristics.LENS_FACING_BACK
            } ?: cm.cameraIdList.firstOrNull() ?: return
            cm.setTorchMode(rearId, on)
        } catch (e: Exception) {
            android.util.Log.w("CamNet", "setTorch($on) failed: $e")
        }
    }

    /** Called from any screen's back/home button to navigate to the home screen. */
    @JavascriptInterface
    fun goHome() {
        (context as? MainActivity)?.runOnUiThread {
            (context as? MainActivity)?.showHome()
        }
    }

    /** Called by camera.js when streaming starts — starts the camera foreground service. */
    @JavascriptInterface
    fun startStreaming() {
        (context as? MainActivity)?.runOnUiThread {
            try {
                ContextCompat.startForegroundService(context, Intent(context, StreamingService::class.java))
            } catch (t: Throwable) {
                android.util.Log.w("CamNet", "startForegroundService failed: $t")
            }
        }
    }

    /** Called by camera.js when streaming ends — stops the camera foreground service. */
    @JavascriptInterface
    fun stopStreaming() {
        try {
            context.stopService(Intent(context, StreamingService::class.java))
        } catch (e: Exception) {
            android.util.Log.w("CamNet", "stopService failed: $e")
        }
    }

    /**
     * Temporarily stores a plaintext password from the Kotlin setup screen so camera.js
     * can read it (and hash it) after camera.html loads. Cleared on first read.
     */
    @JavascriptInterface
    fun setPendingPassword(password: String) {
        context.getSharedPreferences("camnet", Context.MODE_PRIVATE)
            .edit().putString("pending_password", password).apply()
    }

    /** Returns the pending password and immediately clears it. */
    @JavascriptInterface
    fun getPendingPassword(): String {
        val prefs = context.getSharedPreferences("camnet", Context.MODE_PRIVATE)
        val pw = prefs.getString("pending_password", "") ?: ""
        prefs.edit().remove("pending_password").apply()
        return pw
    }

    /** Called from setup screen to save server URL and load camera.html. */
    @JavascriptInterface
    fun setServerUrl(url: String) {
        val clean = url.trim().trimEnd('/')
        context.getSharedPreferences("camnet", Context.MODE_PRIVATE)
            .edit().putString("server_url", clean).apply()
        (context as? MainActivity)?.runOnUiThread { onLoadUrl("$clean/camera.html") }
    }

    /**
     * Called from the QR scanner in the setup screen.
     * Parses the full join URL (https://IP:3443/?room=ABCDEF), saves the base
     * URL, and loads camera.html with the room code pre-filled via ?room=.
     * Normalises http→https and port 3000→3443 so old or mis-encoded QRs still work.
     */
    @JavascriptInterface
    fun openCameraFromQR(scannedUrl: String) {
        try {
            val uri = android.net.Uri.parse(scannedUrl.trim())
            // Cameras must use the SSL proxy; normalise if QR was encoded with the plain HTTP port
            val scheme = "https"
            val rawPort = uri.port
            val port = if (rawPort == SignalingService.PORT) CamNetServer.SSL_PORT
                       else if (rawPort != -1) rawPort
                       else CamNetServer.SSL_PORT
            val base = "$scheme://${uri.host}:$port"
            val room  = uri.getQueryParameter("room")  ?: ""
            val nonce = uri.getQueryParameter("nonce") ?: ""
            context.getSharedPreferences("camnet", Context.MODE_PRIVATE)
                .edit().putString("server_url", base).apply()
            val query = buildString {
                if (room.isNotEmpty())  append("?room=$room")
                if (nonce.isNotEmpty()) append(if (room.isNotEmpty()) "&nonce=$nonce" else "?nonce=$nonce")
            }
            val dest = "$base/camera.html$query"
            android.util.Log.i("CamNet", "openCameraFromQR: room=$room nonce=$nonce dest=$dest")
            (context as? MainActivity)?.runOnUiThread { onLoadUrl(dest) }
        } catch (e: Exception) {
            android.util.Log.w("CamNet", "openCameraFromQR failed: $e")
        }
    }

    /** Called from camera.js long-press on session code to reset the server URL. */
    @JavascriptInterface
    fun resetServer() {
        context.getSharedPreferences("camnet", Context.MODE_PRIVATE)
            .edit().remove("server_url").apply()
        (context as? MainActivity)?.runOnUiThread {
            (context as? MainActivity)?.showHome()
        }
    }

    /**
     * Called from the home screen "Monitor" button.
     * Runs everything on the UI thread so Android 14's foreground-service
     * restrictions see a user-driven foreground context, not a background thread.
     */
    @JavascriptInterface
    fun startMonitor() {
        val port = SignalingService.PORT
        val activity = context as? MainActivity ?: return
        activity.runOnUiThread {
            // Start service on UI thread — required on Android 14+ when calling from
            // a @JavascriptInterface (which otherwise runs on a background thread).
            try {
                ContextCompat.startForegroundService(context, Intent(context, SignalingService::class.java))
            } catch (t: Throwable) {
                android.util.Log.w("CamNet", "startSignalingService failed: $t")
                android.widget.Toast.makeText(context, "Failed to start server: $t", android.widget.Toast.LENGTH_LONG).show()
                return@runOnUiThread
            }

            // Show a native spinner while Kotlin polls for the server — avoids
            // relying on WebView's JS fetch(), which can be blocked by Samsung's
            // network security sandbox on Android 14.
            val spinner = """
                <!DOCTYPE html><html><head>
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <style>*{margin:0;padding:0}body{background:#090910;color:#94a3b8;
                  font-family:-apple-system,sans-serif;display:flex;flex-direction:column;
                  align-items:center;justify-content:center;min-height:100vh;gap:16px}</style>
                </head><body>
                <div style="width:32px;height:32px;border:3px solid #1e293b;
                  border-top-color:#3b82f6;border-radius:50%;animation:s 0.8s linear infinite"></div>
                <style>@keyframes s{to{transform:rotate(360deg)}}</style>
                <span style="font-size:15px">Starting server…</span>
                </body></html>
            """.trimIndent()
            activity.webView.loadDataWithBaseURL(
                "file:///android_asset/", spinner, "text/html", "UTF-8", null
            )
        }

        // Poll TCP port from a background thread — no JS or WebView fetch needed.
        thread(isDaemon = true, name = "camnet-server-poll") {
            repeat(40) {
                if (SignalingService.isRunning()) {
                    // isRunning() flips true as soon as SslProxy.start() is called,
                    // but the background thread may not have bound the port yet.
                    // Confirm the SSL port is actually accepting before loading.
                    try {
                        java.net.Socket("127.0.0.1", CamNetServer.SSL_PORT).use {}
                        // Pass LAN IP in URL fragment so viewer.js can use it directly,
                        // bypassing fetch('/api/info') which fails on Samsung WebView
                        // even when the cert is in NSC (known Samsung fetch() SSL bug).
                        val sslPort = CamNetServer.SSL_PORT
                        val wsPort  = SignalingService.PORT   // plain HTTP/WS port
                        val lanIP   = CamNetServer.getLanIP() ?: ""
                        // Pass both LAN IP and plain WS port in the fragment.
                        // viewer.js uses ws://localhost:wsPort (plain) so the WebSocket
                        // never needs SSL — avoids Samsung WebView's JS cert validation bug.
                        val frag = buildString {
                            if (lanIP.isNotEmpty()) append("lan=$lanIP&")
                            append("wsport=$wsPort")
                        }
                        activity.runOnUiThread {
                            // Clear spinner from back-stack so pressing back goes home, not to spinner.
                            activity.webView.clearHistory()
                            activity.webView.loadUrl(
                                "https://localhost:$sslPort/viewer.html#$frag"
                            )
                        }
                        return@thread
                    } catch (_: Exception) {
                        // SSL port not ready yet — fall through and sleep
                    }
                }
                Thread.sleep(500)
            }
            // Server never came up — show a useful error
            activity.runOnUiThread {
                android.widget.Toast.makeText(
                    context, "Server failed to start. Check notifications or restart the app.",
                    android.widget.Toast.LENGTH_LONG
                ).show()
                activity.showHome()
            }
        }
    }

    /**
     * Called from the home screen "Camera" button — shows the IP-input setup
     * screen so the user can enter the server phone's address.
     */
    @JavascriptInterface
    fun showCameraSetup() {
        (context as? MainActivity)?.runOnUiThread {
            (context as? MainActivity)?.showSetup()
        }
    }

    /**
     * Called from the home screen "Solo" button — loads solo.html directly from
     * assets (no Ktor server needed; all logic is local JS + camera).
     */
    @JavascriptInterface
    fun startSolo() {
        val activity = context as? MainActivity ?: return
        activity.runOnUiThread {
            try {
                ContextCompat.startForegroundService(context, Intent(context, StreamingService::class.java))
            } catch (t: Throwable) {
                android.util.Log.w("CamNet", "startSolo: startForegroundService failed: $t")
            }
            activity.webView.clearHistory()
            // Load solo.html from assets via loadDataWithBaseURL so relative CSS/JS paths resolve.
            // Base URL uses file:///android_asset/ so the WebView treats it as local-origin
            // and grants camera/mic permission requests (same pattern as setupHtml).
            try {
                val html = activity.assets.open("public/solo.html").bufferedReader().readText()
                activity.webView.loadDataWithBaseURL(
                    "file:///android_asset/public/", html, "text/html", "UTF-8", null
                )
            } catch (e: Exception) {
                android.util.Log.e("CamNet", "startSolo load failed: $e")
                android.widget.Toast.makeText(context, "Could not load Solo mode: $e", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }

    /**
     * POSTs a push notification to a ntfy-compatible topic URL via HttpURLConnection.
     * Called by solo.js on motion detection and test button.
     * Runs on a background thread — never blocks the UI.
     *
     * Compatible with ntfy.sh, self-hosted ntfy, and any webhook that accepts a POST
     * with Title / Priority / Message headers (or a raw body).
     *
     * @param topicUrl   Full URL of the ntfy topic (e.g. https://ntfy.sh/my-topic)
     * @param title      Notification title (X-Title header)
     * @param body       Notification body (request body text)
     * @param imageBase64 Optional JPEG base64 data URL for a thumbnail attachment; pass "" to skip
     */
    @JavascriptInterface
    fun sendWebhookNotification(topicUrl: String, title: String, body: String, imageBase64: String) {
        kotlin.concurrent.thread(isDaemon = true, name = "camnet-ntfy") {
            try {
                val url  = java.net.URL(topicUrl.trim())
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod    = "POST"
                conn.doOutput         = true
                conn.connectTimeout   = 8_000
                conn.readTimeout      = 8_000
                conn.setRequestProperty("Title",    title)
                conn.setRequestProperty("Priority", "high")
                conn.setRequestProperty("Content-Type", "text/plain; charset=utf-8")

                // Try with JPEG attachment; fall back to text-only if rejected (free tier, size limit)
                var sentWithImage = false
                if (imageBase64.isNotEmpty()) {
                    try {
                        val bytes = android.util.Base64.decode(
                            imageBase64.substringAfter(","), android.util.Base64.DEFAULT
                        )
                        conn.setRequestProperty("Filename", "motion.jpg")
                        conn.setRequestProperty("X-Message", body)
                        conn.setRequestProperty("Content-Type", "image/jpeg")
                        conn.outputStream.use { it.write(bytes) }
                        sentWithImage = true
                    } catch (_: Exception) {}
                }
                if (!sentWithImage) {
                    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }

                val code = conn.responseCode
                android.util.Log.i("CamNet", "ntfy POST $topicUrl → HTTP $code (image=$sentWithImage)")
                conn.disconnect()

                when {
                    code == 429 -> (context as? MainActivity)?.runOnUiThread {
                        android.widget.Toast.makeText(context,
                            "ntfy rate limit hit — reduce notification frequency or upgrade plan",
                            android.widget.Toast.LENGTH_LONG).show()
                    }
                    code !in 200..299 -> (context as? MainActivity)?.runOnUiThread {
                        android.widget.Toast.makeText(context, "Notification failed (HTTP $code)", android.widget.Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (e: Exception) {
                android.util.Log.w("CamNet", "sendWebhookNotification failed: $e")
                (context as? MainActivity)?.runOnUiThread {
                    android.widget.Toast.makeText(context, "Notification error: ${e.message}", android.widget.Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    /**
     * Called from viewer.js when motion is detected. Fires a high-priority Android
     * notification visible on lock screen / when app is backgrounded, with optional
     * snapshot thumbnail. Each camera gets its own notification slot keyed by name.
     */
    @JavascriptInterface
    fun fireMotionAlert(cameraName: String, snapshotBase64: String?,
                        playSound: Boolean, vibrate: Boolean) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val channel = NotificationChannel(
            "camnet_motion", "Motion Alerts", NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Motion detected on camera"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 250, 100, 250)
            enableLights(true)
            setShowBadge(true)
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            setSound(Settings.System.DEFAULT_NOTIFICATION_URI, attrs)
        }
        nm.createNotificationChannel(channel)

        val tapIntent = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val builder = NotificationCompat.Builder(context, "camnet_motion")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("Motion detected")
            .setContentText(cameraName)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setContentIntent(tapIntent)
            .setDefaults(
                (if (playSound) NotificationCompat.DEFAULT_SOUND   else 0) or
                (if (vibrate)   NotificationCompat.DEFAULT_VIBRATE else 0)
            )
            .also { if (!playSound) it.setSound(null) }

        if (!snapshotBase64.isNullOrEmpty()) {
            try {
                val bytes = android.util.Base64.decode(
                    snapshotBase64.substringAfter(","), android.util.Base64.DEFAULT
                )
                val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                if (bmp != null) {
                    builder.setLargeIcon(bmp)
                    builder.setStyle(
                        NotificationCompat.BigPictureStyle()
                            .bigPicture(bmp)
                            .bigLargeIcon(null as android.graphics.Bitmap?)
                    )
                }
            } catch (_: Exception) {}
        }

        nm.notify(cameraName.hashCode(), builder.build())
    }

    /**
     * Called from camera.js saveCameraRecording(). Decodes the base64 video data URL
     * and saves it to DCIM/CamNet in the device gallery via MediaStore.
     */
    @JavascriptInterface
    fun saveVideo(dataUrl: String, filename: String) {
        try {
            val bytes = android.util.Base64.decode(
                dataUrl.substringAfter(","), android.util.Base64.DEFAULT
            )
            val mimeType = if (filename.endsWith(".mp4")) "video/mp4" else "video/webm"
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Video.Media.DISPLAY_NAME, filename)
                put(android.provider.MediaStore.Video.Media.MIME_TYPE, mimeType)
                put(android.provider.MediaStore.Video.Media.RELATIVE_PATH, "DCIM/CamNet")
            }
            val uri = context.contentResolver.insert(
                android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values
            )
            uri?.let { context.contentResolver.openOutputStream(it)?.use { s -> s.write(bytes) } }
                ?: throw Exception("MediaStore insert returned null")
            (context as? MainActivity)?.runOnUiThread {
                android.widget.Toast.makeText(context, "Video saved to gallery", android.widget.Toast.LENGTH_SHORT).show()
            }
        } catch (e: Exception) {
            android.util.Log.e("CamNet", "saveVideo failed: $e")
            (context as? MainActivity)?.runOnUiThread {
                android.widget.Toast.makeText(context, "Could not save video", android.widget.Toast.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * Called from viewer.js takeSnapshot(). Decodes the JPEG data URL and saves
     * it to DCIM/CamNet in the device gallery via MediaStore.
     */
    @JavascriptInterface
    fun saveSnapshot(dataUrl: String, filename: String) {
        try {
            val bytes = android.util.Base64.decode(
                dataUrl.substringAfter(","), android.util.Base64.DEFAULT
            )
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, filename)
                put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "DCIM/CamNet")
            }
            val uri = context.contentResolver.insert(
                android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values
            )
            uri?.let { context.contentResolver.openOutputStream(it)?.use { s -> s.write(bytes) } }
                ?: throw Exception("MediaStore insert returned null")
            (context as? MainActivity)?.runOnUiThread {
                android.widget.Toast.makeText(context, "Photo saved to gallery", android.widget.Toast.LENGTH_SHORT).show()
            }
        } catch (e: Exception) {
            android.util.Log.e("CamNet", "saveSnapshot failed: $e")
            (context as? MainActivity)?.runOnUiThread {
                android.widget.Toast.makeText(context, "Could not save photo", android.widget.Toast.LENGTH_SHORT).show()
            }
        }
    }
}
