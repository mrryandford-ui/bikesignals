package com.camnet.app

import android.content.res.AssetManager
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoHTTPD.IHTTPSession
import fi.iki.elonen.NanoHTTPD.Response
import fi.iki.elonen.NanoWSD
import fi.iki.elonen.NanoWSD.WebSocket
import fi.iki.elonen.NanoWSD.WebSocketFrame
import org.json.JSONObject
import java.io.IOException
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URLConnection
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.ConcurrentHashMap

/**
 * HTTP + WebSocket signaling server — a Kotlin port of server.js.
 * Serves static assets from Android assets/public/ and relays WebRTC
 * signaling messages between viewer and camera peers.
 */
class CamNetServer(port: Int, private val assets: AssetManager) : NanoWSD(port) {

    // ── Room state ────────────────────────────────────────────────
    private inner class Room {
        @Volatile var viewer: CamSocket? = null
        val cameras = ConcurrentHashMap<String, CamSocket>()
        @Volatile var cleanupTimer: Timer? = null
    }

    private val rooms = ConcurrentHashMap<String, Room>()

    // ── Per-connection WebSocket with session state ───────────────
    inner class CamSocket(handshake: IHTTPSession) : WebSocket(handshake) {
        val id: String = uid()
        @Volatile var roomId: String? = null
        @Volatile var role: String? = null      // "viewer" | "camera"
        @Volatile var cameraName: String? = null

        override fun onOpen() {}
        override fun onPong(pong: WebSocketFrame?) {}

        override fun onMessage(frame: WebSocketFrame) {
            val raw = frame.textPayload ?: return
            val msg = try { JSONObject(raw) } catch (_: Exception) { return }
            handle(msg)
        }

        override fun onClose(code: WebSocketFrame.CloseCode?, reason: String?, byRemote: Boolean) = cleanup()
        override fun onException(e: IOException) = cleanup()

        private fun cleanup() {
            val rId = roomId ?: return
            val room = rooms[rId] ?: return
            if (role == "viewer") {
                room.cleanupTimer?.cancel()
                val t = Timer()
                room.cleanupTimer = t
                t.schedule(object : TimerTask() {
                    override fun run() {
                        if (rooms[rId] === room) {
                            room.cameras.values.forEach { cam ->
                                trySend(cam, jObj("type" to "viewer-disconnected"))
                            }
                            rooms.remove(rId)
                        }
                    }
                }, 25_000L)
            } else if (role == "camera") {
                room.cameras.remove(id)
                room.viewer?.let { trySend(it, jObj("type" to "camera-left", "cameraId" to id)) }
            }
        }

        @Suppress("NAME_SHADOWING")
        private fun handle(msg: JSONObject) {
            when (msg.optString("type")) {

                "create-room" -> {
                    roomId?.let { old ->
                        val r = rooms[old]
                        if (r?.viewer === this) rooms.remove(old)
                    }
                    val id = roomCode()
                    rooms[id] = Room().also { it.viewer = this }
                    roomId = id; role = "viewer"
                    trySend(this, jObj("type" to "room-created", "roomId" to id, "lanIP" to lanIP()))
                }

                "rejoin-room" -> {
                    val rId = msg.optString("roomId").uppercase().trim()
                    val room = rooms[rId]
                    if (room == null) {
                        val newId = roomCode()
                        rooms[newId] = Room().also { it.viewer = this }
                        roomId = newId; role = "viewer"
                        trySend(this, jObj("type" to "room-created", "roomId" to newId, "lanIP" to lanIP()))
                        return
                    }
                    room.cleanupTimer?.cancel(); room.cleanupTimer = null
                    room.viewer = this; roomId = rId; role = "viewer"
                    // Re-announce cameras BEFORE telling them to resend — order matters
                    room.cameras.forEach { (camId, cam) ->
                        trySend(this, jObj(
                            "type" to "camera-joined",
                            "cameraId" to camId,
                            "cameraName" to (cam.cameraName ?: camId)
                        ))
                    }
                    trySend(this, jObj("type" to "room-rejoined", "roomId" to rId))
                    room.cameras.values.forEach { trySend(it, jObj("type" to "viewer-reconnected")) }
                }

                "join-room" -> {
                    val rId = msg.optString("roomId").uppercase().trim()
                    val room = rooms[rId]
                    if (room == null) {
                        trySend(this, jObj(
                            "type" to "error", "code" to "NO_ROOM",
                            "message" to "Room not found. Check the code and try again."
                        ))
                        return
                    }
                    val name = msg.optString("cameraName").trim()
                        .ifEmpty { "Camera ${room.cameras.size + 1}" }
                    // Remove stale entry with same camera name
                    room.cameras.entries.firstOrNull { it.value.cameraName == name }?.let { stale ->
                        room.cameras.remove(stale.key)
                        room.viewer?.let { v ->
                            trySend(v, jObj("type" to "camera-left", "cameraId" to stale.key))
                        }
                    }
                    roomId = rId; role = "camera"; cameraName = name
                    room.cameras[id] = this
                    trySend(this, jObj("type" to "joined", "cameraId" to id, "cameraName" to name))
                    room.viewer?.let {
                        trySend(it, jObj("type" to "camera-joined", "cameraId" to id, "cameraName" to name))
                    }
                }

                "offer", "answer", "ice-candidate" -> {
                    val room = rooms[roomId ?: return] ?: return
                    if (role == "camera") {
                        room.viewer?.let { trySend(it, JSONObject(msg.toString()).put("cameraId", id)) }
                    } else if (role == "viewer") {
                        room.cameras[msg.optString("cameraId")]?.let { trySend(it, msg) }
                    }
                }

                "camera-command" -> {
                    if (role != "viewer") return
                    val room = rooms[roomId ?: return] ?: return
                    room.cameras[msg.optString("cameraId")]?.let { trySend(it, msg) }
                }

                "camera-status" -> {
                    if (role != "camera") return
                    val room = rooms[roomId ?: return] ?: return
                    room.viewer?.let { trySend(it, JSONObject(msg.toString()).put("cameraId", id)) }
                }

                "ping" -> trySend(this, jObj("type" to "pong", "ts" to msg.optLong("ts")))
            }
        }
    }

    override fun openWebSocket(handshake: IHTTPSession): WebSocket = CamSocket(handshake)

    // ── HTTP file serving ─────────────────────────────────────────
    override fun serveHttp(session: IHTTPSession): Response {
        val raw = session.uri.removePrefix("/")
        if (raw == "api/info") return serveApiInfo()
        val path = when {
            raw.isEmpty() || raw == "index.html" -> "public/index.html"
            else -> "public/$raw"
        }
        return try {
            val input = assets.open(path)
            val mime  = URLConnection.guessContentTypeFromName(path) ?: mimeOf(path)
            val resp  = newChunkedResponse(Response.Status.OK, mime, input)
            if (path.endsWith(".js") || path.endsWith(".html"))
                resp.addHeader("Cache-Control", "no-store")
            resp
        } catch (_: IOException) {
            newFixedLengthResponse(Response.Status.NOT_FOUND, NanoHTTPD.MIME_PLAINTEXT, "Not found: $path")
        }
    }

    private fun serveApiInfo(): Response {
        val ips   = localIPs()
        val first = ips.firstOrNull()
        val arr   = ips.joinToString(",") { """{"address":"$it","family":"IPv4","internal":false}""" }
        val json  = """{"lanIP":${if (first != null) "\"$first\"" else "null"},"allIPs":[$arr]}"""
        return newFixedLengthResponse(Response.Status.OK, "application/json", json)
    }

    // ── Helpers ───────────────────────────────────────────────────
    private fun trySend(ws: WebSocket?, obj: JSONObject) {
        try { ws?.send(obj.toString()) } catch (_: Exception) {}
    }

    private fun uid() = java.util.UUID.randomUUID().toString().replace("-", "").take(8)

    private fun roomCode(): String {
        val chars = ('A'..'Z') + ('0'..'9')
        return (1..6).map { chars.random() }.joinToString("")
    }

    fun lanIP(): String? = localIPs().firstOrNull()

    fun localIPs(): List<String> = try {
        NetworkInterface.getNetworkInterfaces()?.toList()
            .orEmpty()
            .filter { !it.isLoopback && it.isUp }
            .flatMap { it.inetAddresses.toList() }
            .filterIsInstance<Inet4Address>()
            .filter { !it.isLoopbackAddress }
            .mapNotNull { it.hostAddress }
            .distinct()
    } catch (_: Exception) { emptyList() }

    private fun mimeOf(path: String) = when {
        path.endsWith(".js")      -> "application/javascript"
        path.endsWith(".css")     -> "text/css"
        path.endsWith(".html")    -> "text/html"
        path.endsWith(".json")    -> "application/json"
        path.endsWith(".webmanifest") -> "application/manifest+json"
        path.endsWith(".png")     -> "image/png"
        path.endsWith(".svg")     -> "image/svg+xml"
        else -> "application/octet-stream"
    }

    private fun jObj(vararg pairs: Pair<String, Any?>): JSONObject =
        JSONObject().also { o -> pairs.forEach { (k, v) -> if (v != null) o.put(k, v) } }
}
