package com.camnet.app

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.*
import androidx.core.app.NotificationCompat

/**
 * Foreground service that declares camera + microphone usage so Android
 * keeps the process alive and camera hardware accessible while the screen is off.
 * A PARTIAL_WAKE_LOCK prevents the CPU from sleeping mid-stream.
 */
class StreamingService : Service() {

    companion object {
        private const val CHANNEL_ID = "camnet_streaming"
        private const val NOTIF_ID   = 1
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIF_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            )
        } else {
            startForeground(NOTIF_ID, notification)
        }

        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "CamNet::StreamingWakeLock"
        ).also { it.acquire(8 * 60 * 60 * 1000L) } // 8-hour safety cap

        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        wakeLock?.release()
        wakeLock = null
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Camera Streaming",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description  = "CamNet is actively streaming"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val tap = packageManager.getLaunchIntentForPackage(packageName)
        val pi  = PendingIntent.getActivity(
            this, 0, tap,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CamNet")
            .setContentText("Camera is streaming — screen can be off")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentIntent(pi)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }
}
