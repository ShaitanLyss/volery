package com.volery.phone

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The one secret this phone keeps, wrapped by a key it cannot export.
 *
 * **Why the phrase is not simply a preference.** `Config.persist` writes a
 * plain `SharedPreferences` file, and a key phrase in there is a key phrase in
 * every backup, every `adb pull`, every copied data directory. The phrase is
 * what lets this phone join the flyway, so it gets the treatment a credential
 * gets: an AES-256 key generated inside the Android Keystore, which on this
 * hardware never leaves the secure element in usable form, and the phrase kept
 * in preferences only as ciphertext under a random IV. A stolen prefs file is
 * then useless off the device, and [put] is the only writer.
 *
 * **Why it is stored at all.** The APK used to carry the phrase, baked in from
 * `local.properties` at build time, which meant any copy of the APK carried it
 * too. Moving it to something you type raised the obvious cost: a phrase held
 * only in memory has to be retyped after every reboot, update or process death,
 * and a phone that asks for 52 characters every morning is a phone nobody
 * carries. Lyss chose the wrapped store over retyping.
 *
 * **When it cannot be read, it is simply absent.** A wiped Keystore, a restored
 * backup, a device that regenerated its key: decryption throws, [get] answers
 * null, and the app asks for the phrase again. That is the same state as a
 * fresh install, which everything already handles.
 *
 * StrongBox is asked for where the device has it and quietly given up on where
 * it does not; a TEE-backed key is still non-exportable.
 */
object Kept {
    private const val PREFS = "volery.kept"
    private const val FIELD = "key-phrase"
    private const val ALIAS = "volery.key-phrase"
    private const val TAG_BITS = 128

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun store(): KeyStore =
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun make(strongBox: Boolean): SecretKey {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val spec = KeyGenParameterSpec.Builder(
            ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .apply { if (strongBox) setIsStrongBoxBacked(true) }
            .build()
        gen.init(spec)
        return gen.generateKey()
    }

    private fun key(): SecretKey {
        (store().getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        /* StrongBox first, and only where the platform has the call at all —
           `setIsStrongBoxBacked` is API 28. A device without the hardware
           throws, and falling back is not a downgrade worth warning about:
           the alternative on that device is no key at all. */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                return make(strongBox = true)
            } catch (_: StrongBoxUnavailableException) {
            } catch (_: java.security.InvalidAlgorithmParameterException) {
            }
        }
        return make(strongBox = false)
    }

    /** Keep the phrase, or forget the old one and say why it could not be. */
    fun put(context: Context, phrase: String): Boolean = try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key())
        }
        val sealed = cipher.iv + cipher.doFinal(phrase.toByteArray(Charsets.UTF_8))
        prefs(context).edit()
            .putString(FIELD, Base64.encodeToString(sealed, Base64.NO_WRAP))
            .apply()
        true
    } catch (t: Throwable) {
        /* A Keystore that refuses to make a key is not a reason to lose the
           phrase for this session, so the caller keeps it in `Config.key`
           either way and only the surviving-a-reboot half is lost. */
        android.util.Log.w("VoleryKept", "the phrase could not be wrapped", t)
        false
    }

    /** The phrase, or null when there is none or it can no longer be opened. */
    fun get(context: Context): String? {
        val raw = prefs(context).getString(FIELD, null) ?: return null
        return try {
            val sealed = Base64.decode(raw, Base64.NO_WRAP)
            if (sealed.size <= 12) return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, sealed, 0, 12))
            }
            String(cipher.doFinal(sealed, 12, sealed.size - 12), Charsets.UTF_8)
        } catch (t: Throwable) {
            /* Not a fault to report: a key the device cannot open is a key
               this phone does not have, and the settings row says "not set". */
            null
        }
    }

    fun forget(context: Context) {
        prefs(context).edit().remove(FIELD).apply()
    }
}
