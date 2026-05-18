package com.camnet.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.*
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    internal lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setupCrashReporter()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val url = webView.url ?: ""
                when {
                    // viewer.html loads on localhost — skip the spinner in back-stack and go home
                    url.startsWith("https://localhost") -> showHome()
                    webView.canGoBack() -> webView.goBack()
                    else -> showHome()
                }
            }
        })
        requestPermissions()

        webView = WebView(this).also { setContentView(it) }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            cacheMode = WebSettings.LOAD_NO_CACHE
        }

        webView.addJavascriptInterface(
            AndroidBridge(this, ::onLoadUrl),
            "AndroidBridge"
        )

        webView.webViewClient = object : WebViewClient() {
            @SuppressLint("WebViewClientOnReceivedSslError")
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                val url     = error.url ?: ""
                val urlHost = runCatching { java.net.URI(url).host }.getOrNull() ?: ""
                val trusted = isPrivateHost(urlHost)
                android.util.Log.w("CamNet", "SSL error for '$urlHost' trusted=$trusted url=$url")
                if (trusted) handler.proceed() else {
                    android.util.Log.e("CamNet", "SSL BLOCKED for '$urlHost' url=$url")
                    handler.cancel()
                    android.widget.Toast.makeText(this@MainActivity,
                        "Blocked SSL from untrusted host: $urlHost", android.widget.Toast.LENGTH_LONG).show()
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                val url  = request.url?.toString() ?: "unknown"
                val code = error.errorCode
                val desc = error.description?.toString() ?: "unknown"
                android.util.Log.e("CamNet", "WebView main frame error: $code $desc — $url")
                try {
                    val entry = "[${java.time.LocalDateTime.now()}] WebView error $code: $desc\nURL: $url\n\n"
                    java.io.File(filesDir, "crash_report.txt").appendText(entry)
                } catch (_: Exception) {}
                runOnUiThread {
                    android.widget.Toast.makeText(this@MainActivity,
                        "Load failed ($code): $desc", android.widget.Toast.LENGTH_LONG).show()
                    showHome()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val originStr = request.origin?.toString() ?: ""
                val host = runCatching { java.net.URI(originStr).host }.getOrNull() ?: ""
                // Trust local origins: file:// (setup screen loaded via loadDataWithBaseURL),
                // data: URIs, and null/empty origin — plus any private-IP LAN host.
                val isTrustedLocal = originStr.startsWith("file://") ||
                                     originStr.startsWith("data:")   ||
                                     originStr == "null"             ||
                                     originStr.isEmpty()
                if (isTrustedLocal || isPrivateHost(host)) {
                    request.grant(request.resources)
                } else {
                    request.deny()
                }
            }
        }

        checkAndOfferCrashReport()
        showHome()
        checkForUpdate()
    }

    // ── Auto-update ───────────────────────────────────────────────
    internal fun checkForUpdate(manual: Boolean = false) {
        Thread {
            try {
                val url  = java.net.URL("https://api.github.com/repos/mrryandford-ui/CamNet/releases/latest")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.setRequestProperty("Accept", "application/vnd.github+json")
                conn.connectTimeout = 5_000
                conn.readTimeout    = 5_000
                if (conn.responseCode != 200) {
                    if (manual) runOnUiThread { android.widget.Toast.makeText(this, "Update check failed (HTTP ${conn.responseCode})", android.widget.Toast.LENGTH_LONG).show() }
                    return@Thread
                }
                val json        = org.json.JSONObject(conn.inputStream.bufferedReader().readText())
                val latestTag   = json.getString("tag_name")
                val latestNum   = latestTag.trimStart('v').toIntOrNull() ?: return@Thread
                val currentNum  = BuildConfig.VERSION_CODE
                val currentName = try { packageManager.getPackageInfo(packageName, 0).versionName ?: "?" } catch (_: Exception) { "?" }
                val latestName  = "1.$latestNum"
                android.util.Log.i("CamNet", "Update check: latest=$latestNum ($latestName) current=$currentNum ($currentName)")
                if (latestNum <= currentNum) {
                    if (manual) runOnUiThread { android.widget.Toast.makeText(this, "Already on latest version (v$currentName)", android.widget.Toast.LENGTH_SHORT).show() }
                    return@Thread
                }
                val assets = json.getJSONArray("assets")
                var apkUrl: String? = null
                for (i in 0 until assets.length()) {
                    val asset = assets.getJSONObject(i)
                    if (asset.getString("name").endsWith(".apk")) {
                        apkUrl = asset.getString("browser_download_url"); break
                    }
                }
                if (apkUrl == null) return@Thread
                val finalApkUrl = apkUrl
                runOnUiThread {
                    AlertDialog.Builder(this)
                        .setTitle("Update available")
                        .setMessage("CamNet v$latestName is available (you have v$currentName).\n\nDownload and install now?")
                        .setPositiveButton("Update") { _, _ -> downloadAndInstall(finalApkUrl, latestNum) }
                        .setNegativeButton("Later", null)
                        .show()
                }
            } catch (e: Exception) {
                if (manual) runOnUiThread { android.widget.Toast.makeText(this, "Update check failed: ${e.message}", android.widget.Toast.LENGTH_LONG).show() }
            }
        }.start()
    }

    private fun downloadAndInstall(apkUrl: String, version: Int) {
        android.widget.Toast.makeText(this, "Downloading CamNet v${version}…", android.widget.Toast.LENGTH_SHORT).show()
        Thread {
            try {
                android.util.Log.i("CamNet", "downloadAndInstall: start url=$apkUrl")
                val request = android.app.DownloadManager.Request(android.net.Uri.parse(apkUrl)).apply {
                    setTitle("CamNet v${version}")
                    setDescription("Downloading update…")
                    setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalFilesDir(
                        this@MainActivity,
                        android.os.Environment.DIRECTORY_DOWNLOADS,
                        "CamNet-v${version}.apk"
                    )
                    // NOTE: do NOT call setMimeType("application/vnd.android.package-archive") on Android 14+.
                }
                val dm = getSystemService(DOWNLOAD_SERVICE) as android.app.DownloadManager
                val downloadId = dm.enqueue(request)
                android.util.Log.i("CamNet", "downloadAndInstall: enqueued id=$downloadId")
                val query = android.app.DownloadManager.Query().setFilterById(downloadId)
                var downloading = true
                while (downloading) {
                    Thread.sleep(1_000)
                    val cursor = dm.query(query)
                    if (cursor.moveToFirst()) {
                        val status = cursor.getInt(cursor.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_STATUS))
                        when (status) {
                            android.app.DownloadManager.STATUS_SUCCESSFUL -> {
                                downloading = false; runOnUiThread { promptInstall(version) }
                            }
                            android.app.DownloadManager.STATUS_FAILED -> {
                                downloading = false
                                val reason = cursor.getInt(cursor.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_REASON))
                                android.util.Log.e("CamNet", "downloadAndInstall: failed reason=$reason")
                                runOnUiThread { android.widget.Toast.makeText(this, "Download failed (reason $reason)", android.widget.Toast.LENGTH_LONG).show() }
                            }
                        }
                    }
                    cursor.close()
                }
            } catch (e: Exception) {
                android.util.Log.e("CamNet", "downloadAndInstall exception", e)
                runOnUiThread { android.widget.Toast.makeText(this, "Update failed: ${e.message}", android.widget.Toast.LENGTH_LONG).show() }
            }
        }.start()
    }

    private fun promptInstall(version: Int) {
        val file = java.io.File(
            getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS),
            "CamNet-v${version}.apk"
        )
        android.util.Log.i("CamNet", "Install file: ${file.path} exists=${file.exists()} size=${file.length()}")
        if (!file.exists() || file.length() == 0L) {
            runOnUiThread { android.widget.Toast.makeText(this, "APK download incomplete — try again", android.widget.Toast.LENGTH_LONG).show() }
            return
        }

        if (!packageManager.canRequestPackageInstalls()) {
            android.util.Log.w("CamNet", "promptInstall: REQUEST_INSTALL_PACKAGES not granted — redirecting to settings")
            runOnUiThread {
                startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    android.net.Uri.parse("package:$packageName")))
                android.widget.Toast.makeText(this,
                    "Allow CamNet to install apps in Settings, then tap Update again",
                    android.widget.Toast.LENGTH_LONG).show()
            }
            return
        }

        val uri = androidx.core.content.FileProvider.getUriForFile(this, "${packageName}.provider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        runOnUiThread { startActivity(intent) }
    }

    // ── Crash reporting ───────────────────────────────────────────
    private fun setupCrashReporter() {
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val pkgInfo = packageManager.getPackageInfo(packageName, 0)
                val versionName = pkgInfo.versionName ?: "?"
                val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                    pkgInfo.longVersionCode else @Suppress("DEPRECATION") pkgInfo.versionCode.toLong()
                val report = buildString {
                    appendLine("CamNet Crash Report")
                    appendLine("===================")
                    appendLine("Version : $versionName ($versionCode)")
                    appendLine("Device  : ${Build.MANUFACTURER} ${Build.MODEL}")
                    appendLine("Android : ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
                    appendLine("Time    : ${java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss z", java.util.Locale.US).format(java.util.Date())}")
                    appendLine("Thread  : ${thread.name}")
                    appendLine()
                    appendLine(throwable.stackTraceToString())
                }
                java.io.File(filesDir, "crash_report.txt").writeText(report)
            } catch (_: Exception) {}
            defaultHandler?.uncaughtException(thread, throwable)
                ?: android.os.Process.killProcess(android.os.Process.myPid())
        }
    }

    private fun checkAndOfferCrashReport() {
        val crashFile = java.io.File(filesDir, "crash_report.txt")
        if (!crashFile.exists()) return
        val report = try { crashFile.readText() } catch (_: Exception) { crashFile.delete(); return }
        AlertDialog.Builder(this)
            .setTitle("CamNet crashed")
            .setMessage("The app crashed last session. Share a report?")
            .setPositiveButton("Share") { _, _ ->
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_SUBJECT, "CamNet Crash Report")
                    putExtra(Intent.EXTRA_TEXT, report)
                }
                startActivity(Intent.createChooser(intent, "Share crash report"))
                crashFile.delete()
            }
            .setNegativeButton("Dismiss") { _, _ -> crashFile.delete() }
            .show()
    }

    // ── Navigation ────────────────────────────────────────────────
    fun onLoadUrl(url: String) {
        android.util.Log.i("CamNet", "onLoadUrl: $url")
        try {
            webView.loadUrl(url)
        } catch (e: Exception) {
            android.util.Log.e("CamNet", "onLoadUrl failed: $e")
            android.widget.Toast.makeText(this, "Failed to load: $url\n$e",
                android.widget.Toast.LENGTH_LONG).show()
        }
    }

    fun showHome() {
        // Clear back-stack so the Monitor → Back → Camera flow always renders a
        // fresh screen and never resurrects a stale data:// page from history.
        webView.clearHistory()
        webView.loadDataWithBaseURL("file:///android_asset/", homeHtml(), "text/html", "UTF-8", null)
    }

    fun showSetup() {
        webView.clearHistory()
        webView.loadDataWithBaseURL("file:///android_asset/", setupHtml(), "text/html", "UTF-8", null)
    }

    // ── Home screen ───────────────────────────────────────────────
    private fun homeHtml(): String {
        val versionName = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0"
        } catch (e: Exception) { "1.0" }
        return """
        <!DOCTYPE html><html><head>
        <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
        <style>
          *{box-sizing:border-box;margin:0;padding:0}
          body{background:#090910;color:#f1f5f9;font-family:-apple-system,sans-serif;
               display:flex;flex-direction:column;align-items:center;justify-content:center;
               min-height:100vh;padding:32px 24px;gap:16px}
          h1{font-size:32px;font-weight:800;letter-spacing:-0.5px}
          .tagline{color:#64748b;font-size:14px;text-align:center;margin-bottom:8px}
          .btn{display:block;width:100%;padding:18px;border:none;border-radius:16px;
               font-size:17px;font-weight:700;cursor:pointer;text-align:center;
               -webkit-tap-highlight-color:transparent;transition:opacity 0.15s}
          .btn:active{opacity:0.75}
          .primary{background:#3b82f6;color:#fff}
          .secondary{background:#1e293b;color:#f1f5f9;border:1.5px solid #334155}
          .divider{width:100%;border:none;border-top:1px solid #1e293b;margin:4px 0}
          .hint{color:#475569;font-size:12px;text-align:center;line-height:1.6}
          .logo{width:72px;height:72px;background:#090910;border-radius:20px;display:flex;align-items:center;justify-content:center;margin-bottom:4px;box-shadow:0 0 40px rgba(59,130,246,0.3)}
          .footer{position:fixed;bottom:20px;left:0;right:0;display:flex;flex-direction:column;
                  align-items:center;gap:3px}
          .version{color:#334155;font-size:11px;font-weight:600;letter-spacing:0.5px}
          .copyright{color:#1e293b;font-size:10px;letter-spacing:0.3px}
        </style></head><body>
        <div class="logo">
          <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 108 108' width='72' height='72'>
            <circle cx='44' cy='54' r='20' fill='#3B82F6'/>
            <circle cx='44' cy='54' r='15' fill='#090910'/>
            <circle cx='44' cy='54' r='9'  fill='#3B82F6'/>
            <circle cx='44' cy='54' r='4'  fill='#090910'/>
            <path d='M28,43 Q33,36 41,39 Q36,45 34,51 Z' fill='#FFFFFF' fill-opacity='0.45'/>
            <path d='M67,41 A26,26,0,0,1,67,67' stroke='#FFFFFF' stroke-width='4.5' stroke-linecap='round' fill='none'/>
            <path d='M71,39 A31,31,0,0,1,71,69' stroke='#FFFFFF' stroke-width='4.5' stroke-linecap='round' fill='none'/>
            <path d='M75,36 A36,36,0,0,1,75,72' stroke='#FFFFFF' stroke-width='4.5' stroke-linecap='round' fill='none'/>
          </svg>
        </div>
        <h1>CamNet</h1>
        <p class="tagline">Multi-phone security camera</p>
        <button class="btn primary"   onclick="AndroidBridge.startMonitor()">🖥&nbsp; Monitor</button>
        <button class="btn secondary" onclick="AndroidBridge.showCameraSetup()">📷&nbsp; Camera</button>
        <button onclick="AndroidBridge.checkForUpdateManual()"
          style="background:transparent;border:1.5px solid #1e293b;color:#64748b;
                 font-size:13px;padding:10px;width:100%;border-radius:12px;
                 margin-top:4px;cursor:pointer;-webkit-tap-highlight-color:transparent">
          ⬆ Check for updates
        </button>
        <hr class="divider">
        <p class="hint">Monitor: start the server &amp; watch feeds<br>Camera: stream this phone to a Monitor</p>
        <div class="footer">
          <span class="version">v$versionName</span>
          <span class="copyright">&copy; 2026 ZeroPoint IT &middot; All rights reserved</span>
        </div>
        </body></html>
        """.trimIndent()
    }

    // ── Camera setup screen ───────────────────────────────────────
    private fun setupHtml(): String {
        val lastIp = try {
            val url = getSharedPreferences("camnet", android.content.Context.MODE_PRIVATE)
                .getString("server_url", "") ?: ""
            android.net.Uri.parse(url).host ?: ""
        } catch (_: Exception) { "" }
        return """
        <!DOCTYPE html><html><head>
        <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
        <style>
          *{box-sizing:border-box;margin:0;padding:0}
          body{background:#090910;color:#f1f5f9;font-family:-apple-system,sans-serif;
               display:flex;flex-direction:column;align-items:center;justify-content:center;
               min-height:100vh;padding:32px 24px;gap:16px}
          h1{font-size:22px;font-weight:700}
          p{color:#94a3b8;font-size:14px;text-align:center;line-height:1.5;max-width:300px}
          .row{display:flex;align-items:center;width:100%;background:#1e293b;
               border:1.5px solid #334155;border-radius:14px;overflow:hidden}
          .prefix{padding:14px 0 14px 16px;color:#64748b;font-size:16px;white-space:nowrap;user-select:none}
          .suffix{padding:14px 16px 14px 0;color:#64748b;font-size:16px;white-space:nowrap;user-select:none}
          input{flex:1;padding:14px 4px;font-size:16px;background:transparent;color:#f1f5f9;
                border:none;outline:none;min-width:0}
          button{width:100%;padding:15px;background:#3b82f6;color:#fff;border:none;
                 border-radius:14px;font-size:16px;font-weight:600;cursor:pointer;
                 -webkit-tap-highlight-color:transparent}
          .outline{background:transparent;border:1.5px solid #334155;color:#f1f5f9}
          .back{background:transparent;color:#64748b;font-size:14px;padding:8px;width:auto}
          .hint{color:#475569;font-size:12px;text-align:center}
          .divider{display:flex;align-items:center;width:100%;gap:10px;color:#334155;font-size:12px}
          .divider::before,.divider::after{content:'';flex:1;border-top:1px solid #1e293b}
          #scanner{display:none;position:fixed;inset:0;background:#000;z-index:10;
                   flex-direction:column;align-items:center;justify-content:center;gap:20px}
          #scanner.active{display:flex}
          #scanVideo{width:100%;max-width:360px;border-radius:16px;object-fit:cover}
          .scan-frame{position:relative;width:100%;max-width:360px}
          .scan-corner{position:absolute;width:24px;height:24px;border-color:#3b82f6;border-style:solid}
          .scan-corner.tl{top:0;left:0;border-width:3px 0 0 3px;border-radius:4px 0 0 0}
          .scan-corner.tr{top:0;right:0;border-width:3px 3px 0 0;border-radius:0 4px 0 0}
          .scan-corner.bl{bottom:0;left:0;border-width:0 0 3px 3px;border-radius:0 0 0 4px}
          .scan-corner.br{bottom:0;right:0;border-width:0 3px 3px 0;border-radius:0 0 4px 0}
          .scan-hint{color:#94a3b8;font-size:14px;text-align:center}
          .scan-cancel{background:transparent;border:1.5px solid #334155;color:#94a3b8;
                       font-size:15px;padding:12px 32px;border-radius:12px;width:auto}
        </style></head><body>
        <h1>📷 Join Session</h1>
        <p>Scan the QR code on the Monitor phone, or enter the IP manually</p>
        <button class="outline" id="scanBtn" onclick="startScan()">
          &#x2317;&nbsp; Scan QR Code
        </button>
        <div class="divider" id="divider">or</div>
        <div class="row">
          <span class="prefix">https://</span>
          <input id="ip" type="text" inputmode="decimal" value="$lastIp"
                 autocomplete="off" autocorrect="off" spellcheck="false">
          <span class="suffix">:3443</span>
        </div>
        <input id="pw" type="password" placeholder="Password (if required — ask monitor user)"
          style="width:100%;padding:14px;font-size:15px;background:#1e293b;
          border:1.5px solid #334155;border-radius:14px;color:#f1f5f9;
          outline:none;box-sizing:border-box;flex:none">
        <button onclick="connect()">Connect &rarr;</button>
        <button class="back" id="backBtn">← Back</button>
        <p class="hint">First visit: tap Advanced &rarr; Proceed (once only)</p>

        <!-- QR scanner overlay -->
        <div id="scanner">
          <div class="scan-frame">
            <video id="scanVideo" autoplay playsinline muted></video>
            <div class="scan-corner tl"></div><div class="scan-corner tr"></div>
            <div class="scan-corner bl"></div><div class="scan-corner br"></div>
          </div>
          <p class="scan-hint">Point at the QR code on the Monitor phone</p>
          <button class="scan-cancel" onclick="stopScan()">Cancel</button>
        </div>

        <script>
          document.getElementById('ip').focus();
          document.getElementById('backBtn').onclick = function(){ AndroidBridge.resetServer(); };

          function connect(){
            if(window._navigatingAway) return;
            var ip = document.getElementById('ip').value.trim().replace(/[\/\s]/g,'');
            if(!ip) return;
            window._navigatingAway = true;
            var pw = document.getElementById('pw').value.trim();
            if(pw) AndroidBridge.setPendingPassword(pw);
            document.querySelector('button[onclick="connect()"]').textContent = 'Connecting…';
            AndroidBridge.setServerUrl('https://'+ip+':3443');
          }
          document.getElementById('ip').addEventListener('keydown', function(e){
            if(e.key === 'Enter') connect();
          });

          var scanStream = null, scanInterval = null;
          async function startScan() {
            if (!('BarcodeDetector' in window)) {
              alert('QR scanning is not supported on this WebView. Enter the IP manually.');
              return;
            }
            try {
              scanStream = await navigator.mediaDevices.getUserMedia(
                {video:{facingMode:'environment',width:{ideal:1280},height:{ideal:720}}}
              );
              var video = document.getElementById('scanVideo');
              video.srcObject = scanStream;
              document.getElementById('scanner').classList.add('active');
              var detector = new BarcodeDetector({formats:['qr_code']});
              scanInterval = setInterval(async function(){
                if(video.readyState < 2) return;
                try {
                  var codes = await detector.detect(video);
                  if(codes.length > 0){
                    var raw = codes[0].rawValue;
                    stopScan();
                    // Always populate the IP field so the user sees something
                    try {
                      var u = new URL(raw);
                      document.getElementById('ip').value = u.hostname;
                    } catch(e2) {
                      document.getElementById('ip').value = raw;
                    }
                    // Guard connect() so it can't fire after we've already navigated
                    window._navigatingAway = true;
                    AndroidBridge.openCameraFromQR(raw);
                  }
                } catch(e){}
              }, 250);
            } catch(e) {
              alert('Camera access denied — enter IP manually.');
            }
          }
          function stopScan(){
            clearInterval(scanInterval); scanInterval = null;
            if(scanStream){ scanStream.getTracks().forEach(function(t){t.stop();}); scanStream = null; }
            document.getElementById('scanner').classList.remove('active');
          }
        </script></body></html>
    """.trimIndent()
    }

    // ── System UI ─────────────────────────────────────────────────
    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.apply {
                hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            )
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    // ── Permissions ───────────────────────────────────────────────
    private fun isPrivateHost(host: String): Boolean {
        if (host == "localhost" || host == "127.0.0.1") return true
        val parts = host.split(".").mapNotNull { it.toIntOrNull() }
        if (parts.size != 4) return false
        return parts[0] == 10 ||
            (parts[0] == 172 && parts[1] in 16..31) ||
            (parts[0] == 192 && parts[1] == 168) ||
            (parts[0] == 100 && parts[1] in 64..127)  // RFC 6598 CGNAT / Tailscale
    }

    private fun requestPermissions() {
        val needed = buildList {
            add(Manifest.permission.CAMERA)
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty())
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1)
    }
}
