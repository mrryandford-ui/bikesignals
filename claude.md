2026-05-18 — Moto G / Android 14/15 update install fixes

- Symptom: Update flow on Moto G silently failed — DownloadManager.enqueue() threw (no download entries), install intent never launched. REQUEST_INSTALL_PACKAGES appop was Default (never granted) so promptInstall() silently failed.

- Root causes:
  1. Code used setDestinationUri(Uri.fromFile(...)) which fails on modern Android and with APK MIME types.
  2. Code used setMimeType("application/vnd.android.package-archive") on DownloadManager.Request — Android 14+ or some OEMs block APK MIME before enqueue.
  3. promptInstall() did not check packageManager.canRequestPackageInstalls(), so the flow launched installer without ensuring the user allowed installs from this source.
  4. Exceptions were swallowed in a catch block; error Toasts were being killed before the cause could be seen in logcat.

- Fix applied (single commit on branch fix/apk-install-android14):
  - Replace setDestinationUri(Uri.fromFile(...)) with setDestinationInExternalFilesDir(...).
  - Remove setMimeType("application/vnd.android.package-archive") from the DownloadManager Request.
  - Add logging: Log.i for start/enqueue and Log.e for failures and exceptions.
  - Add packageManager.canRequestPackageInstalls() guard in promptInstall() that redirects to ACTION_MANAGE_UNKNOWN_APP_SOURCES with a Toast to instruct the user.
  - Keep using FileProvider.getUriForFile(...) and Intent.ACTION_VIEW with FLAG_GRANT_READ_URI_PERMISSION to launch the installer.

- Implemented and pushed by GitHub Copilot (@copilot)

- How to test:
  1. On a device (Moto G / Android 14/15), Settings → Apps → Special app access → Install unknown apps → CamNet — toggle Allow from this source ON.
  2. Launch CamNet, tap Update. Watch logcat for:
     - "CamNet downloadAndInstall: start url="
     - "CamNet downloadAndInstall: enqueued id="
     - If failure: "downloadAndInstall: failed reason=..."
     - If exception: "downloadAndInstall exception" with stacktrace
     - On successful download: promptInstall() will either open the installer or redirect user to Settings if permission missing.
  3. Confirm installer UI appears and allows Install.

- Notes / caveats:
  - Using setDestinationInExternalFilesDir keeps the APK in app-scoped external files; post-install cleanup is app responsibility.
  - Some OEMs still exhibit non-standard DownloadManager behavior; logging makes debugging easier.
  - If you want to support background, silent installs (device owner), that requires different APIs and elevated privileges; this fix is for normal user-installed updates via installer UI.

- Contact:
  - Commit & PR authored and pushed by GitHub Copilot (@copilot)
