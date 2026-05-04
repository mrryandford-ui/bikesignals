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
                "http://localhost:$port/", spinner, "text/html", "UTF-8", null
            )
        }

        // Poll TCP port from a background thread — no JS or WebView fetch needed.
        thread(isDaemon = true, name = "camnet-server-poll") {
            repeat(40) {
                if (SignalingService.isRunning()) {
                    activity.runOnUiThread {
                        activity.webView.loadUrl("http://localhost:$port/viewer.html")
                    }
                    return@thread
                }
                try { java.net.Socket("127.0.0.1", port).use {} } catch (_: Exception) {}
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
     * Called from the home screen "Camera (this phone)" button when the
     * embedded server is already running here — loads camera.html from localhost.
     */
    @JavascriptInterface
    fun startLocalCamera() {
        (context as? MainActivity)?.runOnUiThread {
            onLoadUrl("http://localhost:${SignalingService.PORT}/camera.html")
        }
    }
}
