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
    private class Room(val nonce: String) {
        @Volatile var viewer: DefaultWebSocketSession? = null
        val cameras = ConcurrentHashMap<String, CamRecord>()
        @Volatile var cleanupTimer: Timer? = null
        val cameraCounter = java.util.concurrent.atomic.AtomicInteger(0)
        @Volatile var passwordHash: String? = null // SHA-256 hex, null = no password
    }

    // ── Rate limiting ─────────────────────────────────────────────
    private val joinAttempts = ConcurrentHashMap<String, MutableList<Long>>()
    private val joinLock = Any()

    private fun isRateLimited(ip: String): Boolean = synchronized(joinLock) {
        val now   = System.currentTimeMillis()
        val max   = 10; val window = 60_000L
        val list  = joinAttempts.getOrPut(ip) { mutableListOf() }
        list.removeAll { it < now - window }
        if (list.size >= max) return true
        list.add(now); false
    }

    private class CamRecord(
        val session: DefaultWebSocketSession,
        val id: String,
        @Volatile var cameraName: String? = null,
    )

    // ── Per-connection state ──────────────────────────────────────
    private class SessionState(val id: String, val remoteIp: String = "unknown") {
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
            webSocket("/")         {
                val ip = try { call.request.origin.remoteHost } catch (_: Exception) { "unknown" }
                handleSocket(this, ip)
            }
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

    fun start() {
        engine.start(wait = false); sslProxy.start(); started = true
        // Periodically purge stale rate-limit entries to prevent unbounded growth
        cleanupScope.launch {
            while (true) {
                kotlinx.coroutines.delay(5 * 60 * 1000L)
                val cutoff = System.currentTimeMillis() - 60_000L
                synchronized(joinLock) {
                    joinAttempts.values.forEach { it.removeAll { ts -> ts < cutoff } }
                    joinAttempts.entries.removeIf { it.value.isEmpty() }
                }
            }
        }
    }
    fun stop()  { sslProxy.stop(); engine.stop(0, 0); cleanupScope.cancel(); started = false }
    val isAlive get() = started

    // ── WebSocket session handler ─────────────────────────────────
    private suspend fun handleSocket(ws: DefaultWebSocketSession, remoteIp: String = "unknown") {
        val state = SessionState(uid(), remoteIp)
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
                val id = roomCode(); val nonce = sessionSecret()
                rooms[id] = Room(nonce).also { it.viewer = ws }
                state.roomId = id; state.role = "viewer"
                trySend(ws, jObj("type" to "room-created", "roomId" to id, "nonce" to nonce, "lanIP" to lanIP()))
            }

            "rejoin-room" -> {
                val rId = msg.optString("roomId").uppercase().trim()
                val room = rooms[rId]
                if (room == null) {
                    val id = roomCode(); val nonce = sessionSecret()
                    rooms[id] = Room(nonce).also { it.viewer = ws }
                    state.roomId = id; state.role = "viewer"
                    trySend(ws, jObj("type" to "room-created", "roomId" to id, "nonce" to nonce, "lanIP" to lanIP()))
                    return
                }
                room.cleanupTimer?.cancel(); room.cleanupTimer = null
                room.viewer = ws; state.roomId = rId; state.role = "viewer"
                room.cameras.forEach { (camId, cam) ->
                    trySend(ws, jObj("type" to "camera-joined", "cameraId" to camId, "cameraName" to (cam.cameraName ?: camId)))
                }
                trySend(ws, jObj("type" to "room-rejoined", "roomId" to rId, "nonce" to room.nonce))
                room.cameras.values.forEach { trySend(it.session, jObj("type" to "viewer-reconnected")) }
            }

            "join-room" -> {
                if (isRateLimited(state.remoteIp)) {
                    trySend(ws, jObj("type" to "error", "code" to "RATE_LIMITED",
                        "message" to "Too many join attempts — wait 60 seconds and try again."))
                    return
                }
                val rId = msg.optString("roomId").uppercase().trim()
                val room = rooms[rId]
                if (room == null) {
                    trySend(ws, jObj("type" to "error", "code" to "NO_ROOM",
                        "message" to "Room not found. Check the code and try again."))
                    return
                }
                // Nonce must match — prevents join with code alone (e.g. leaked 8-char code)
                if (msg.optString("nonce") != room.nonce) {
                    trySend(ws, jObj("type" to "error", "code" to "BAD_TOKEN",
                        "message" to "Invalid join token. Use the QR code or full link."))
                    return
                }
                // Optional session password check
                val pwHash = room.passwordHash
                if (pwHash != null && msg.optString("passwordHash") != pwHash) {
                    trySend(ws, jObj("type" to "error", "code" to "BAD_PASSWORD",
                        "message" to "Incorrect session password."))
                    return
                }
                val name = msg.optString("cameraName").trim()
                    .ifEmpty { "Camera ${room.cameraCounter.incrementAndGet()}" }
                room.cameras.entries.firstOrNull { it.value.cameraName == name }?.let { stale ->
                    room.cameras.remove(stale.key)
                    room.viewer?.let { v -> trySend(v, jObj("type" to "camera-left", "cameraId" to stale.key)) }
                }
                state.roomId = rId; state.role = "camera"; state.cameraName = name
                room.cameras[state.id] = CamRecord(ws, state.id, name)
                trySend(ws, jObj("type" to "joined", "cameraId" to state.id, "cameraName" to name))
                room.viewer?.let { trySend(it, jObj("type" to "camera-joined", "cameraId" to state.id, "cameraName" to name)) }
            }

            "set-password" -> {
                val room = rooms[state.roomId ?: return] ?: return
                if (state.role != "viewer") return
                val hash = msg.optString("hash").lowercase().trim()
                room.passwordHash = hash.ifEmpty { null }
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

    private val secureRandom = java.security.SecureRandom()
    private val ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no O/0/I/1

    private fun roomCode(): String {
        val sb = StringBuilder(8)
        repeat(8) { sb.append(ALPHABET[secureRandom.nextInt(ALPHABET.length)]) }
        return sb.toString()
    }

    private fun sessionSecret(): String {
        val bytes = ByteArray(16); secureRandom.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    fun lanIP(): String? = localIPs().firstOrNull()

    fun localIPs(): List<String> = try {
        val all = NetworkInterface.getNetworkInterfaces()?.toList()
            .orEmpty()
            .filter { !it.isLoopback && it.isUp }
            .flatMap { it.inetAddresses.toList() }
            .filterIsInstance<Inet4Address>()
            .filter { !it.isLoopbackAddress }
            .mapNotNull { it.hostAddress }
            .distinct()
        // Prefer RFC1918 private IPs (WiFi/LAN) over RFC6598 CGNAT/Tailscale (100.64-127.x)
        val lan = all.filter { ip ->
            val p = ip.split(".").mapNotNull { it.toIntOrNull() }
            p.size == 4 && (
                p[0] == 10 ||
                (p[0] == 172 && p[1] in 16..31) ||
                (p[0] == 192 && p[1] == 168)
            )
        }
        if (lan.isNotEmpty()) lan else all
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
