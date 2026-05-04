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
            allowFileAccessFromFileURLs = true
            allowUniversalAccessFromFileURLs = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }

        webView.addJavascriptInterface(
            AndroidBridge(this) { url -> webView.loadUrl(url) },
            "AndroidBridge"
        )

        webView.webViewClient = object : WebViewClient() {
            @SuppressLint("WebViewClientOnReceivedSslError")
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.proceed()
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
            override fun onPermissionRequest(request: PermissionRequest) = request.grant(request.resources)
        }

        showHome()
    }

    // ── Navigation ────────────────────────────────────────────────
    fun showHome() {
        webView.loadDataWithBaseURL("file:///android_asset/", homeHtml(), "text/html", "UTF-8", null)
    }

    fun showSetup() {
        webView.loadDataWithBaseURL("file:///android_asset/", setupHtml(), "text/html", "UTF-8", null)
    }

    // ── Home screen ───────────────────────────────────────────────
    private fun homeHtml(): String {
        val serverRunning = SignalingService.isRunning()
        val localCameraBtn = if (serverRunning) """
            <button class="btn secondary" onclick="AndroidBridge.startLocalCamera()">📷 Camera (this phone)</button>
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
        </style></head><body>
        <h1>CamNet</h1>
        <p class="tagline">Multi-phone security camera</p>
        <button class="btn primary"   onclick="AndroidBridge.startMonitor()">🖥&nbsp; Monitor</button>
        <button class="btn secondary" onclick="AndroidBridge.showCameraSetup()">📷&nbsp; Camera (other phone)</button>
        $localCameraBtn
        <hr class="divider">
        <p class="hint">Monitor: start the server &amp; watch feeds<br>Camera: stream to a Monitor phone</p>
        </body></html>
        """.trimIndent()
    }

    // ── Camera setup screen ───────────────────────────────────────
    private fun setupHtml(): String = """
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
          .back{background:transparent;color:#64748b;font-size:14px;padding:8px;width:auto}
          .hint{color:#475569;font-size:12px;text-align:center}
        </style></head><body>
        <h1>📷 Join Session</h1>
        <p>Enter the IP address shown on the Monitor phone</p>
        <div class="row">
          <span class="prefix">https://</span>
          <input id="ip" type="text" inputmode="decimal" placeholder="192.168.0.43"
                 autocomplete="off" autocorrect="off" spellcheck="false">
          <span class="suffix">:3443</span>
        </div>
        <button onclick="connect()">Connect &rarr;</button>
        <button class="back" onclick="AndroidBridge.showCameraSetup !== undefined && history.back()">← Back</button>
        <p class="hint">First visit: tap Advanced → Proceed (once only)</p>
        <script>
          document.getElementById('ip').focus();
          function connect(){
            var ip=document.getElementById('ip').value.trim().replace(/[\/\s]/g,'');
            if(!ip)return;
            document.querySelector('button').textContent='Connecting…';
            AndroidBridge.setServerUrl('https://'+ip+':3443');
          }
          document.getElementById('ip').addEventListener('keydown',function(e){
            if(e.key==='Enter')connect();
          });
          document.querySelector('.back').onclick=function(){
            AndroidBridge.resetServer();
          };
        </script></body></html>
    """.trimIndent()

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
