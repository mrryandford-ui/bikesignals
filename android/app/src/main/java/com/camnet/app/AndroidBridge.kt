package com.camnet.app

import android.content.Context
import android.content.Intent
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import kotlin.concurrent.thread

class AndroidBridge(
    private val context: Context,
    private val onLoadUrl: (String) -> Unit,
) {
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
            val room = uri.getQueryParameter("room") ?: ""
            context.getSharedPreferences("camnet", Context.MODE_PRIVATE)
                .edit().putString("server_url", base).apply()
            val dest = if (room.isNotEmpty()) "$base/camera.html?room=$room" else "$base/camera.html"
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
                        val sslPort = CamNetServer.SSL_PORT
                        activity.runOnUiThread {
                            activity.webView.loadUrl("https://localhost:$sslPort/viewer.html")
                        }
                        return@thread
                    } catch (_: Exception) {
                        // SSL port not ready yet — fall through and sleep
                    }
                }
                Thread.sleep(100) // short sleep before recheck
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
