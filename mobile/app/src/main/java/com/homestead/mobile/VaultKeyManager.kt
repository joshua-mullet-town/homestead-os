package com.homestead.mobile

import android.content.Context
import android.content.Intent
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Manages the vault encryption key in Android Keystore (hardware-backed).
 *
 * The key NEVER leaves the Secure Element / TEE. Every encrypt/decrypt operation
 * requires a fresh biometric authentication via CryptoObject.
 */
object VaultKeyManager {
    private const val TAG = "VaultKeyManager"
    private const val KEYSTORE_ALIAS = "homestead_vault_key"
    private const val VAULT_FILENAME = "vault.enc"
    private const val SA_KEY_FILENAME = "sa_key.enc"
    private const val GCM_TAG_LENGTH = 128

    // Biometric coordination
    enum class Operation { ENCRYPT, DECRYPT, ENCRYPT_SA, DECRYPT_SA }

    @Volatile
    var pendingOperation: Operation? = null
        private set

    @Volatile
    var pendingPlaintext: String? = null
        private set

    @Volatile
    var pendingResult: CompletableDeferred<String?>? = null
        private set

    /**
     * Request a vault sync (encrypt + store).
     * Returns a deferred that completes with "ok" on success or null on failure.
     */
    fun requestSync(context: Context, plaintext: String): CompletableDeferred<String?> {
        val deferred = CompletableDeferred<String?>()
        pendingOperation = Operation.ENCRYPT
        pendingPlaintext = plaintext
        pendingResult = deferred
        launchBiometricGate(context)
        return deferred
    }

    /**
     * Request a vault read (decrypt + return full plaintext).
     * Returns a deferred that completes with full decrypted content or null on failure.
     */
    fun requestRead(context: Context): CompletableDeferred<String?> {
        val deferred = CompletableDeferred<String?>()
        pendingOperation = Operation.DECRYPT
        pendingPlaintext = null
        pendingResult = deferred
        launchBiometricGate(context)
        return deferred
    }

    /**
     * Request storing the Google SA key (encrypt + store as sa_key.enc).
     * One-time setup: after this, the SA key lives only on the phone behind biometric.
     */
    fun requestStoreSaKey(context: Context, saKeyJson: String): CompletableDeferred<String?> {
        val deferred = CompletableDeferred<String?>()
        pendingOperation = Operation.ENCRYPT_SA
        pendingPlaintext = saKeyJson
        pendingResult = deferred
        launchBiometricGate(context)
        return deferred
    }

    /**
     * Request decrypting the SA key (returns the SA key JSON after biometric).
     */
    fun requestReadSaKey(context: Context): CompletableDeferred<String?> {
        val deferred = CompletableDeferred<String?>()
        pendingOperation = Operation.DECRYPT_SA
        pendingPlaintext = null
        pendingResult = deferred
        launchBiometricGate(context)
        return deferred
    }

    /**
     * Check if SA key credentials are stored on the phone.
     */
    fun hasSaKey(context: Context): Boolean {
        return File(context.filesDir, SA_KEY_FILENAME).exists()
    }

    /**
     * Called by BiometricGateActivity on biometric success with an authenticated cipher.
     */
    fun onBiometricSuccess(context: Context, cipher: Cipher) {
        try {
            when (pendingOperation) {
                Operation.ENCRYPT -> {
                    encryptToFile(context, cipher, VAULT_FILENAME, "Vault")
                }
                Operation.DECRYPT -> {
                    decryptFromFile(context, cipher, VAULT_FILENAME, "Vault")
                }
                Operation.ENCRYPT_SA -> {
                    encryptToFile(context, cipher, SA_KEY_FILENAME, "SA key")
                }
                Operation.DECRYPT_SA -> {
                    decryptFromFile(context, cipher, SA_KEY_FILENAME, "SA key")
                }
                null -> {
                    pendingResult?.complete(null)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Biometric operation failed", e)
            pendingResult?.complete(null)
        } finally {
            cleanup()
        }
    }

    private fun encryptToFile(context: Context, cipher: Cipher, filename: String, label: String) {
        val plaintext = pendingPlaintext ?: throw IllegalStateException("No plaintext to encrypt")
        val encrypted = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val iv = cipher.iv

        val file = File(context.filesDir, filename)
        file.outputStream().use { out ->
            out.write(iv.size)
            out.write(iv)
            out.write(encrypted)
        }

        Log.d(TAG, "$label encrypted and stored (${file.length()} bytes)")
        pendingResult?.complete("ok")
    }

    private fun decryptFromFile(context: Context, cipher: Cipher, filename: String, label: String) {
        val file = File(context.filesDir, filename)
        if (!file.exists()) {
            pendingResult?.complete(null)
            return
        }

        val data = file.readBytes()
        val ivLen = data[0].toInt() and 0xFF
        val ciphertext = data.sliceArray(1 + ivLen until data.size)

        val plaintext = String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        Log.d(TAG, "$label decrypted (${plaintext.length} chars)")
        pendingResult?.complete(plaintext)
    }

    /**
     * Called by BiometricGateActivity on biometric failure/cancel.
     */
    fun onBiometricFailure() {
        pendingResult?.complete(null)
        cleanup()
    }

    private fun cleanup() {
        pendingOperation = null
        pendingPlaintext = null
        pendingResult = null
    }

    // --- Key management ---

    /**
     * Ensure the Keystore key exists. Creates one if not.
     */
    fun ensureKey() {
        val keyStore = KeyStore.getInstance("AndroidKeyStore")
        keyStore.load(null)

        if (!keyStore.containsAlias(KEYSTORE_ALIAS)) {
            generateKey()
        }
    }

    private fun generateKey() {
        val keyGen = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore"
        )
        keyGen.init(
            KeyGenParameterSpec.Builder(
                KEYSTORE_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(false)
                .build()
        )
        keyGen.generateKey()
        Log.d(TAG, "Generated new hardware-backed vault key")
    }

    /**
     * Get a Cipher initialized for encryption (for BiometricPrompt CryptoObject).
     */
    fun getEncryptCipher(): Cipher {
        ensureKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getKey())
        return cipher
    }

    /**
     * Get a Cipher initialized for decryption (for BiometricPrompt CryptoObject).
     * Reads the IV from the stored encrypted file.
     */
    fun getDecryptCipher(context: Context): Cipher {
        val filename = when (pendingOperation) {
            Operation.DECRYPT_SA -> SA_KEY_FILENAME
            else -> VAULT_FILENAME
        }
        ensureKey()
        val file = File(context.filesDir, filename)
        val data = file.readBytes()
        val ivLen = data[0].toInt() and 0xFF
        val iv = data.sliceArray(1 until 1 + ivLen)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, getKey(), GCMParameterSpec(GCM_TAG_LENGTH, iv))
        return cipher
    }

    private fun getKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore")
        keyStore.load(null)
        return keyStore.getKey(KEYSTORE_ALIAS, null) as SecretKey
    }

    /**
     * Check if a vault file exists on the phone.
     */
    fun hasVault(context: Context): Boolean {
        return File(context.filesDir, VAULT_FILENAME).exists()
    }

    private fun launchBiometricGate(context: Context) {
        val intent = Intent(context, BiometricGateActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }
}
