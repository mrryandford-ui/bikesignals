package com.camnet.app

import android.content.Context
import android.content.Intent
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat

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
        (context as? MainActivity)?.runOnUiThread {
            // Start service on UI thread — required on Android 14+ when calling from
            // a @JavascriptInterface (which otherwise runs on a background thread).
            try {
                ContextCompat.startForegroundService(context, Intent(context, SignalingService::class.java))
            } catch (t: Throwable) {
                android.util.Log.w("CamNet", "startSignalingService failed: $t")
            }

            // Splash page rooted at http://localhost:<port>/ so fetch('/api/info')
            // is same-origin (no CORS) and location.replace navigates within the
            // same origin. Using loadData() would give a null origin and block the fetch.
            val base = "http://localhost:$port/"
            val splash = """
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
                <script>
                  (function poll(n){
                    if(n>30){AndroidBridge.resetServer();return;}
                    fetch('/api/info',{cache:'no-store'})
                      .then(()=>location.replace('/viewer.html'))
                      .catch(()=>setTimeout(()=>poll(n+1),400));
                  })(0);
                </script></body></html>
            """.trimIndent()
            (context as? MainActivity)?.webView
                ?.loadDataWithBaseURL(base, splash, "text/html", "UTF-8", null)
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
