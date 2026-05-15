package com.camnet.app

import android.content.res.AssetManager
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.cio.*
import io.ktor.server.engine.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URLConnection
import java.security.KeyStore
import java.time.Duration
import java.util.Timer
import java.util.TimerTask
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Plain HTTP signaling server (Ktor/CIO) on [port].
 * HTTPS for LAN camera phones is handled by [SslProxy] which terminates TLS
 * and forwards raw TCP to this server — avoids Ktor's TLS stack entirely.
 */
class CamNetServer(port: Int, private val assets: AssetManager, private val context: android.content.Context) {

    private val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // ── Room state ────────────────────────────────────────────────
    private class Room {
        @Volatile var viewer: DefaultWebSocketSession? = null
        val cameras = ConcurrentHashMap<String, CamRecord>()
        @Volatile var cleanupTimer: Timer? = null
        val cameraCounter = java.util.concurrent.atomic.AtomicInteger(0)
    }

    private class CamRecord(
        val session: DefaultWebSocketSession,
        val id: String,
        @Volatile var cameraName: String? = null,
    )

    // ── Per-connection state ──────────────────────────────────────
    private class SessionState(val id: String) {
        @Volatile var roomId: String? = null
        @Volatile var role: String? = null        // "viewer" | "camera"
        @Volatile var cameraName: String? = null
    }

    private val rooms = ConcurrentHashMap<String, Room>()
    @Volatile private var started = false

    // Load the self-signed keystore once; shared with SslProxy
    private val keyStore: KeyStore = KeyStore.getInstance("PKCS12").also { ks ->
        assets.open("camnet-ssl.p12").use { ks.load(it, "camnet-ssl".toCharArray()) }
    }

    private val engine = embeddedServer(CIO, port = port) {
        install(WebSockets) {
            pingPeriod = Duration.ofSeconds(15)
            timeout    = Duration.ofSeconds(60)
        }
        routing {
            webSocket("/")         { handleSocket(this) }
            get("/api/info")       { serveApiInfo(call) }
            post("/api/save-video"){ saveVideoToGallery(call) }
            get("/")               { serveAsset(call) }
            get("/{path...}")      { serveAsset(call) }
        }
    }

    private val sslProxy = SslProxy(
        sslPort     = SSL_PORT,
        backendPort = port,
        keyStore    = keyStore,
    )

    fun start() { engine.start(wait = false); sslProxy.start(); started = true }
    fun stop()  { sslProxy.stop(); engine.stop(0, 0); cleanupScope.cancel(); started = false }
    val isAlive get() = started

    // ── WebSocket session handler ─────────────────────────────────
    private suspend fun handleSocket(ws: DefaultWebSocketSession) {
        val state = SessionState(uid())
        try {
            for (frame in ws.incoming) {
                if (frame !is Frame.Text) continue
                val msg = try { JSONObject(frame.readText()) } catch (_: Exception) { continue }
                handle(ws, state, msg)
            }
        } finally {
            withContext(NonCancellable) { cleanup(ws, state) }
        }
    }

    @Suppress("NAME_SHADOWING")
    private suspend fun handle(ws: DefaultWebSocketSession, state: SessionState, msg: JSONObject) {
        when (msg.optString("type")) {

            "create-room" -> {
                state.roomId?.let { old ->
                    val r = rooms[old]
                    if (r?.viewer === ws) rooms.remove(old)
                }
                val id = roomCode()
                rooms[id] = Room().also { it.viewer = ws }
                state.roomId = id; state.role = "viewer"
                trySend(ws, jObj("type" to "room-created", "roomId" to id, "lanIP" to lanIP()))
            }

            "rejoin-room" -> {
                val rId = msg.optString("roomId").uppercase().trim()
                val room = rooms[rId]
                if (room == null) {
                    val newId = roomCode()
                    rooms[newId] = Room().also { it.viewer = ws }
                    state.roomId = newId; state.role = "viewer"
                    trySend(ws, jObj("type" to "room-created", "roomId" to newId, "lanIP" to lanIP()))
                    return
                }
                room.cleanupTimer?.cancel(); room.cleanupTimer = null
                room.viewer = ws; state.roomId = rId; state.role = "viewer"
                // Re-announce cameras BEFORE telling them to resend — order matters
                room.cameras.forEach { (camId, cam) ->
                    trySend(ws, jObj(
                        "type" to "camera-joined",
                        "cameraId" to camId,
                        "cameraName" to (cam.cameraName ?: camId),
                    ))
                }
                trySend(ws, jObj("type" to "room-rejoined", "roomId" to rId))
                room.cameras.values.forEach { trySend(it.session, jObj("type" to "viewer-reconnected")) }
            }

            "join-room" -> {
                val rId = msg.optString("roomId").uppercase().trim()
                val room = rooms[rId]
                if (room == null) {
                    trySend(ws, jObj(
                        "type" to "error", "code" to "NO_ROOM",
                        "message" to "Room not found. Check the code and try again.",
                    ))
                    return
                }
                val name = msg.optString("cameraName").trim()
                    .ifEmpty { "Camera ${room.cameraCounter.incrementAndGet()}" }
                // Remove stale entry with same camera name
                room.cameras.entries.firstOrNull { it.value.cameraName == name }?.let { stale ->
                    room.cameras.remove(stale.key)
                    room.viewer?.let { v ->
                        trySend(v, jObj("type" to "camera-left", "cameraId" to stale.key))
                    }
                }
                state.roomId = rId; state.role = "camera"; state.cameraName = name
                room.cameras[state.id] = CamRecord(ws, state.id, name)
                trySend(ws, jObj("type" to "joined", "cameraId" to state.id, "cameraName" to name))
                room.viewer?.let {
                    trySend(it, jObj("type" to "camera-joined", "cameraId" to state.id, "cameraName" to name))
                }
            }

            "offer", "answer", "ice-candidate" -> {
                val room = rooms[state.roomId ?: return] ?: return
                if (state.role == "camera") {
                    room.viewer?.let { trySend(it, JSONObject(msg.toString()).put("cameraId", state.id)) }
                } else if (state.role == "viewer") {
                    room.cameras[msg.optString("cameraId")]?.let { trySend(it.session, msg) }
                }
            }

            "camera-command" -> {
                if (state.role != "viewer") return
                val room = rooms[state.roomId ?: return] ?: return
                room.cameras[msg.optString("cameraId")]?.let { trySend(it.session, msg) }
            }

            "camera-status" -> {
                if (state.role != "camera") return
                val room = rooms[state.roomId ?: return] ?: return
                room.viewer?.let { trySend(it, JSONObject(msg.toString()).put("cameraId", state.id)) }
            }

            "ping" -> trySend(ws, jObj("type" to "pong", "ts" to msg.optLong("ts")))
        }
    }

    private suspend fun cleanup(ws: DefaultWebSocketSession, state: SessionState) {
        val rId = state.roomId ?: return
        val room = rooms[rId] ?: return
        if (state.role == "viewer") {
            room.cleanupTimer?.cancel()
            val t = Timer()
            room.cleanupTimer = t
            t.schedule(object : TimerTask() {
                override fun run() {
                    if (rooms[rId] === room) {
                        cleanupScope.launch {
                            room.cameras.values.forEach { cam ->
                                trySend(cam.session, jObj("type" to "viewer-disconnected"))
                            }
                        }
                        rooms.remove(rId)
                    }
                }
            }, 25_000L)
        } else if (state.role == "camera") {
            room.cameras.remove(state.id)
            room.viewer?.let { trySend(it, jObj("type" to "camera-left", "cameraId" to state.id)) }
        }
    }

    // ── HTTP serving ──────────────────────────────────────────────
    private suspend fun serveApiInfo(call: ApplicationCall) {
        val ips   = localIPs()
        val first = ips.firstOrNull()
        val arr   = ips.joinToString(",") { """{"address":"$it","family":"IPv4","internal":false}""" }
        val json  = """{"lanIP":${if (first != null) "\"$first\"" else "null"},"allIPs":[$arr],"sslPort":$SSL_PORT}"""
        call.respondText(json, ContentType.Application.Json)
    }

    private suspend fun saveVideoToGallery(call: ApplicationCall) {
        try {
            val rawName = call.request.header("X-Filename")
                ?.let { java.net.URLDecoder.decode(it, "UTF-8") }
                ?: "CamNet_${System.currentTimeMillis()}.webm"
            val mimeType = call.request.contentType().let {
                if (it == ContentType.Any) "video/webm" else it.toString().substringBefore(';').trim()
            }
            val bytes = call.receive<ByteArray>()
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Video.Media.DISPLAY_NAME, rawName)
                put(android.provider.MediaStore.Video.Media.MIME_TYPE, mimeType)
                put(android.provider.MediaStore.Video.Media.RELATIVE_PATH, "DCIM/CamNet")
            }
            val uri = context.contentResolver.insert(
                android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values
            ) ?: throw Exception("MediaStore insert returned null")
            context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
            call.respondText("""{"ok":true}""", ContentType.Application.Json)
        } catch (e: Exception) {
            android.util.Log.e("CamNet", "saveVideoToGallery failed: $e")
            call.respondText("""{"ok":false,"error":${org.json.JSONObject.quote(e.message ?: "unknown")}}""",
                ContentType.Application.Json, HttpStatusCode.InternalServerError)
        }
    }

    private suspend fun serveAsset(call: ApplicationCall) {
        val raw  = call.request.path().removePrefix("/")
        val path = when {
            raw.isEmpty() || raw == "index.html" -> "public/index.html"
            else -> "public/$raw"
        }
        try {
            val input = assets.open(path)
            val mime  = URLConnection.guessContentTypeFromName(path) ?: mimeOf(path)
            val ct    = try { ContentType.parse(mime) } catch (_: Exception) { ContentType.Application.OctetStream }
            if (path.endsWith(".js") || path.endsWith(".html"))
                call.response.header(HttpHeaders.CacheControl, "no-store")
            call.respondOutputStream(ct) { input.use { it.copyTo(this) } }
        } catch (_: IOException) {
            call.respondText("Not found: $path", status = HttpStatusCode.NotFound)
        }
    }

    // ── Helpers ───────────────────────────────────────────────────
    private suspend fun trySend(ws: DefaultWebSocketSession, obj: JSONObject) {
        try { ws.send(obj.toString()) } catch (_: Exception) {}
    }

    private fun uid() = UUID.randomUUID().toString().replace("-", "").take(8)

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
        path.endsWith(".js")          -> "application/javascript"
        path.endsWith(".css")         -> "text/css"
        path.endsWith(".html")        -> "text/html"
        path.endsWith(".json")        -> "application/json"
        path.endsWith(".webmanifest") -> "application/manifest+json"
        path.endsWith(".png")         -> "image/png"
        path.endsWith(".svg")         -> "image/svg+xml"
        else                          -> "application/octet-stream"
    }

    private fun jObj(vararg pairs: Pair<String, Any?>): JSONObject =
        JSONObject().also { o -> pairs.forEach { (k, v) -> if (v != null) o.put(k, v) } }

    companion object {
        const val SSL_PORT = 3443
    }
}
