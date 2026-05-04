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
        (context as? MainActivity)?.runOnUiThread {
            onLoadUrl("http://localhost:${SignalingService.PORT}/viewer.html")
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
