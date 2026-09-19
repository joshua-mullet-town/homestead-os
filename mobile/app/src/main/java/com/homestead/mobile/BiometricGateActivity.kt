package com.homestead.mobile

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * Transparent activity that shows a BiometricPrompt with a CryptoObject.
 *
 * The CryptoObject wraps a Cipher backed by Android Keystore. The hardware TEE
 * won't allow the cipher to operate until biometric authentication succeeds.
 * This means the key NEVER leaves the secure element.
 */
class BiometricGateActivity : FragmentActivity() {

    companion object {
        private const val TAG = "BiometricGate"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Show over lock screen and turn screen on
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            keyguardManager.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            )
        }

        showBiometricPrompt()
    }

    private fun showBiometricPrompt() {
        val operation = VaultKeyManager.pendingOperation
        if (operation == null) {
            Log.e(TAG, "No pending operation — finishing")
            VaultKeyManager.onBiometricFailure()
            finish()
            return
        }

        // Get the appropriate cipher for the operation
        val cipher = try {
            when (operation) {
                VaultKeyManager.Operation.ENCRYPT, VaultKeyManager.Operation.ENCRYPT_SA -> VaultKeyManager.getEncryptCipher()
                VaultKeyManager.Operation.DECRYPT, VaultKeyManager.Operation.DECRYPT_SA -> VaultKeyManager.getDecryptCipher(this)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize cipher: ${e.message}", e)
            VaultKeyManager.onBiometricFailure()
            finish()
            return
        }

        val executor = ContextCompat.getMainExecutor(this)

        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                Log.d(TAG, "Biometric authentication succeeded")
                val authenticatedCipher = result.cryptoObject?.cipher
                if (authenticatedCipher != null) {
                    VaultKeyManager.onBiometricSuccess(this@BiometricGateActivity, authenticatedCipher)
                } else {
                    Log.e(TAG, "No cipher in CryptoObject after auth")
                    VaultKeyManager.onBiometricFailure()
                }
                finish()
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                Log.w(TAG, "Biometric error ($errorCode): $errString")
                VaultKeyManager.onBiometricFailure()
                finish()
            }

            override fun onAuthenticationFailed() {
                Log.w(TAG, "Biometric authentication failed (bad fingerprint)")
                // Don't finish — BiometricPrompt allows retries
            }
        }

        val subtitle = when (operation) {
            VaultKeyManager.Operation.ENCRYPT -> "Scan fingerprint to save passwords to vault"
            VaultKeyManager.Operation.DECRYPT -> "Scan fingerprint to unlock passwords"
            VaultKeyManager.Operation.ENCRYPT_SA -> "Scan fingerprint to store credentials"
            VaultKeyManager.Operation.DECRYPT_SA -> "Scan fingerprint to access passwords"
        }

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Password Vault")
            .setSubtitle(subtitle)
            .setNegativeButtonText("Cancel")
            .build()

        val cryptoObject = BiometricPrompt.CryptoObject(cipher)
        BiometricPrompt(this, executor, callback).authenticate(promptInfo, cryptoObject)
    }
}
