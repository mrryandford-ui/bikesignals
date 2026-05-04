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

    lateinit var webView: WebView

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
                val url  = request.url?.toString() ?: "unknown"
                val desc = error.description?.toString() ?: "unknown error"
                runOnUiThread {
                    android.widget.Toast.makeText(
                        this@MainActivity,
                        "Can't reach server:\n$desc\n$url",
                        android.widget.Toast.LENGTH_LONG
                    ).show()
                    showSetup()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                request.grant(request.resources)
            }
        }

        val saved = getSharedPreferences("camnet", MODE_PRIVATE).getString("server_url", null)
        if (saved != null) webView.loadUrl("$saved/camera.html") else showSetup()
    }

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

    fun showSetup() {
        // file:///android_asset/ base URL makes AndroidBridge accessible from JS
        webView.loadDataWithBaseURL("file:///android_asset/", setupHtml(), "text/html", "UTF-8", null)
    }

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
          .hint{color:#475569;font-size:12px;text-align:center}
        </style></head><body>
        <h1>CamNet Camera</h1>
        <p>Enter the IP address shown when you run <code>npm start</code> in Termux</p>
        <div class="row">
          <span class="prefix">https://</span>
          <input id="ip" type="text" inputmode="decimal" placeholder="192.168.0.43"
                 autocomplete="off" autocorrect="off" spellcheck="false">
          <span class="suffix">:3000</span>
        </div>
        <button onclick="save()">Connect &rarr;</button>
        <p class="hint">Allow the certificate warning once — tap Advanced &rarr; Proceed</p>
        <script>
          document.getElementById('ip').focus();
          function save(){
            var ip=document.getElementById('ip').value.trim().replace(/[\/\s]/g,'');
            if(!ip)return;
            document.querySelector('button').textContent='Connecting…';
            AndroidBridge.setServerUrl('https://'+ip+':3000');
          }
          document.getElementById('ip').addEventListener('keydown',function(e){
            if(e.key==='Enter')save();
          });
        </script></body></html>
    """.trimIndent()

    private fun requestPermissions() {
        val needed = buildList {
            add(Manifest.permission.CAMERA)
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1)
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
