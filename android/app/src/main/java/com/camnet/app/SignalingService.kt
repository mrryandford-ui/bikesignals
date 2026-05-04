package com.camnet.app

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Foreground service that runs the embedded CamNet HTTP/WebSocket signaling
 * server so the monitor stays available even when the app is in the background.
 */
class SignalingService : Service() {

    companion object {
        private const val TAG        = "CamNet"
        private const val CHANNEL_ID = "camnet_server"
        private const val NOTIF_ID   = 2
        const val PORT = 3000

        var server: CamNetServer? = null
            private set

        fun isRunning() = server?.isAlive == true
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIF_ID, notification)
            }
        } catch (t: Throwable) {
            // If startForeground fails we must stop immediately — if we don't call
            // startForeground within 5 s Android kills the service, and START_STICKY
            // would restart it into the same crash loop.
            Log.w(TAG, "startForeground failed: $t")
            stopSelf()
            return START_NOT_STICKY
        }

        if (server?.isAlive != true) {
            try {
                server = CamNetServer(PORT, assets).also { it.start() }
                Log.i(TAG, "Signaling server started on port $PORT")
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to start signaling server: $t")
                stopSelf()
                return START_NOT_STICKY
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        server?.stop()
        server = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        Log.i(TAG, "Signaling server stopped")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        val ch = NotificationChannel(
            CHANNEL_ID, "CamNet Server",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Running CamNet signaling server"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    private fun buildNotification(): Notification {
        val tap = packageManager.getLaunchIntentForPackage(packageName)
        val pi  = PendingIntent.getActivity(this, 0, tap,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CamNet Monitor")
            .setContentText("Server running — cameras can connect")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentIntent(pi)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }
}
