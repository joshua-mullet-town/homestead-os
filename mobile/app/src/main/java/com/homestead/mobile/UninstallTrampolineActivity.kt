package com.homestead.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log

/**
 * Trampoline activity that launches the system uninstall dialog.
 * Runs in a separate task (taskAffinity="" in manifest) from the HOME launcher.
 * Uses startActivityForResult so the uninstall dialog stays in this task's stack,
 * preventing the HOME singleTask activity from stealing focus.
 */
class UninstallTrampolineActivity : Activity() {
    companion object {
        private const val REQUEST_UNINSTALL = 1
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pkg = intent.getStringExtra("package_name")
        Log.d("UninstallTrampoline", "onCreate for: $pkg task=$taskId")
        if (pkg != null) {
            // Use ACTION_DELETE instead of ACTION_UNINSTALL_PACKAGE
            // and avoid EXTRA_RETURN_RESULT (which causes immediate auto-return on Android 16)
            val uninstallIntent = Intent(Intent.ACTION_DELETE, Uri.parse("package:$pkg"))
            Log.d("UninstallTrampoline", "Starting ACTION_DELETE via startActivity")
            startActivity(uninstallIntent)
        }
        finish()
    }
}
