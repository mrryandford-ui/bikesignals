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
        try {
            ContextCompat.startForegroundService(context, Intent(context, StreamingService::class.java))
        } catch (e: Exception) {
            android.util.Log.w("CamNet", "startForegroundService failed: $e")
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
     * Called from the home screen "Monitor" button — starts the embedded
     * signaling server and loads viewer.html from localhost.
     */
    @JavascriptInterface
    fun startMonitor() {
        try {
            ContextCompat.startForegroundService(context, Intent(context, SignalingService::class.java))
        } catch (e: Exception) {
            android.util.Log.w("CamNet", "startSignalingService failed: $e")
        }
        // Load a splash that polls localhost until Ktor is ready, then redirects.
        // Avoids ERR_EMPTY_RESPONSE when WebView connects before the port is bound.
        val port = SignalingService.PORT
        val splash = """
            <!DOCTYPE html><html><head>
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <style>*{margin:0;padding:0}body{background:#090910;color:#94a3b8;
              font-family:-apple-system,sans-serif;display:flex;align-items:center;
              justify-content:center;min-height:100vh;font-size:16px;gap:12px}</style>
            </head><body>
            <div class="spinner" style="width:24px;height:24px;border:3px solid #1e293b;
              border-top-color:#3b82f6;border-radius:50%;animation:s 0.8s linear infinite"></div>
            <style>@keyframes s{to{transform:rotate(360deg)}}</style>
            <span>Starting server…</span>
            <script>
              (function poll(){
                fetch('http://localhost:$port/api/info',{cache:'no-store'})
                  .then(()=>location.replace('http://localhost:$port/viewer.html'))
                  .catch(()=>setTimeout(poll,400));
              })();
            </script></body></html>
        """.trimIndent()
        (context as? MainActivity)?.runOnUiThread {
            (context as? MainActivity)?.webView?.loadData(splash, "text/html", "UTF-8")
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
