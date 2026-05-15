package com.camnet.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.*
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    internal lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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
            AndroidBridge(this) { url -> webView.loadUrl(url) },
            "AndroidBridge"
        )

        webView.webViewClient = object : WebViewClient() {
            @SuppressLint("WebViewClientOnReceivedSslError")
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                val host = error.url?.let { runCatching { java.net.URL(it).host }.getOrNull() } ?: ""
                if (isPrivateHost(host)) handler.proceed() else {
                    handler.cancel()
                    android.widget.Toast.makeText(this@MainActivity,
                        "Blocked SSL from untrusted host: $host", android.widget.Toast.LENGTH_LONG).show()
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                val desc = error.description?.toString() ?: "unknown error"
                runOnUiThread {
                    android.widget.Toast.makeText(this@MainActivity,
                        "Connection failed: $desc", android.widget.Toast.LENGTH_LONG).show()
                    showHome()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val host = runCatching { java.net.URI(request.origin.toString()).host }.getOrNull() ?: ""
                if (isPrivateHost(host)) request.grant(request.resources) else request.deny()
            }
        }

        showHome()
    }

    // ── Navigation ────────────────────────────────────────────────
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
        val serverRunning = SignalingService.isRunning()
        val localCameraBtn = if (serverRunning) """
            <button class="btn secondary" onclick="AndroidBridge.startLocalCamera()">📷&nbsp; Camera (also this phone)</button>
        """ else ""
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
        $localCameraBtn
        <hr class="divider">
        <p class="hint">Monitor: start the server &amp; watch feeds<br>Camera: stream this phone to a Monitor</p>
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
            var ip = document.getElementById('ip').value.trim().replace(/[\/\s]/g,'');
            if(!ip) return;
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
                    // Attempt auto-connect via the bridge
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

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else showHome()
    }

    // ── Permissions ───────────────────────────────────────────────
    private fun isPrivateHost(host: String): Boolean {
        if (host == "localhost" || host == "127.0.0.1") return true
        val parts = host.split(".").mapNotNull { it.toIntOrNull() }
        if (parts.size != 4) return false
        return parts[0] == 10 ||
            (parts[0] == 172 && parts[1] in 16..31) ||
            (parts[0] == 192 && parts[1] == 168)
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
