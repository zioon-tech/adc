package cloud.agentdevice.node

import android.app.LocaleManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.content.res.Resources
import android.os.Build
import android.os.LocaleList
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import java.util.Locale

internal enum class AppLanguage(val tag: String) {
    SYSTEM(""), CHINESE("zh"), ENGLISH("en");

    companion object {
        const val ACTION_CHANGED = "cloud.agentdevice.node.LANGUAGE_CHANGED"
        private const val PREFERENCES = "adc_language"

        fun selected(context: Context): AppLanguage {
            val tag = if (Build.VERSION.SDK_INT >= 33) {
                context.getSystemService(LocaleManager::class.java).applicationLocales.toLanguageTags()
            } else context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString("tag", "").orEmpty()
            return when (Locale.forLanguageTag(tag.substringBefore(',')).language) {
                "zh" -> CHINESE
                "en" -> ENGLISH
                else -> SYSTEM
            }
        }

        fun applyBeforeCreate(context: Context) {
            if (Build.VERSION.SDK_INT < 33) {
                val locales = LocaleListCompat.forLanguageTags(selected(context).tag)
                if (AppCompatDelegate.getApplicationLocales() != locales) AppCompatDelegate.setApplicationLocales(locales)
            }
        }

        fun select(context: Context, language: AppLanguage) {
            if (selected(context) == language) return
            if (Build.VERSION.SDK_INT < 33) {
                check(context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
                    .putString("tag", language.tag).commit())
            }
            // AppCompat (and Android 13+) applies resources and recreates the Activity once.
            AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(language.tag))
            context.sendBroadcast(Intent(ACTION_CHANGED).setPackage(context.packageName))
        }

        /** Services may start without an Activity, so resolve the preference independently. */
        fun localizedContext(context: Context): Context {
            val language = selected(context)
            val locales = if (language != SYSTEM) LocaleList.forLanguageTags(language.tag)
            else if (Build.VERSION.SDK_INT >= 33) context.getSystemService(LocaleManager::class.java).systemLocales
            else Resources.getSystem().configuration.locales
            return context.createConfigurationContext(Configuration(context.resources.configuration).apply {
                setLocales(locales)
            })
        }

        fun uiLocale(context: Context): Locale = Locale.forLanguageTag(context.getString(R.string.ui_language))
    }
}
