package cloud.agentdevice.node

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.text.Editable
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.view.ContextThemeWrapper
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout

/** All forms, including dialogs, share a single native field and error treatment. */
class MobileFormField(
    context: Context,
    label: String,
    value: String = "",
    type: Int = InputType.TYPE_CLASS_TEXT,
    maxLength: Int = 128,
    multiline: Boolean = false
) : LinearLayout(context) {
    private val palette = MobilePalette(context)
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private val fieldContext = ContextThemeWrapper(context, R.style.Widget_Adc_TextInput)
    val box = TextInputLayout(fieldContext).apply {
        isHintEnabled = false
        boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
        boxBackgroundColor = palette.surface
        setBoxStrokeColorStateList(ColorStateList(
            arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf(android.R.attr.state_focused), intArrayOf()),
            intArrayOf(palette.line, palette.accent, palette.outline)))
        boxStrokeWidth = dp(1)
        boxStrokeWidthFocused = dp(2)
        setBoxCornerRadii(dp(16).toFloat(), dp(16).toFloat(), dp(16).toFloat(), dp(16).toFloat())
        setErrorTextColor(ColorStateList.valueOf(palette.danger))
        setEndIconTintList(ColorStateList.valueOf(palette.muted))
        isSaveEnabled = false
    }
    val input = TextInputEditText(fieldContext).apply {
        // Do not combine the platform underline with Material's box drawable.
        background = null
        inputType = type
        setSingleLine(!multiline)
        if (multiline) {
            minLines = 2
            maxLines = 4
            gravity = android.view.Gravity.TOP
        }
        textSize = 16f
        typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        setTextColor(palette.ink)
        setHintTextColor(palette.muted)
        setPadding(dp(16), dp(16), dp(16), dp(16))
        minimumHeight = dp(56)
        filters = arrayOf(InputFilter.LengthFilter(maxLength))
        imeOptions = EditorInfo.IME_ACTION_NEXT
        isSaveEnabled = false
        setText(value)
        setAutofillHints(when (type and InputType.TYPE_MASK_VARIATION) {
            InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS -> View.AUTOFILL_HINT_EMAIL_ADDRESS
            InputType.TYPE_TEXT_VARIATION_PASSWORD -> View.AUTOFILL_HINT_PASSWORD
            else -> null
        })
        setTag(R.id.form_field, this@MobileFormField)
    }
    init {
        orientation = VERTICAL
        val caption = TextView(context).apply {
            text = label
            textSize = 13f
            setTextColor(palette.muted)
            includeFontPadding = false
            labelFor = View.generateViewId().also { input.id = it }
            setPadding(dp(4), 0, dp(4), dp(8))
        }
        addView(caption, LayoutParams(-1, -2))
        box.addView(input, LayoutParams(-1, -2))
        if (type and InputType.TYPE_MASK_VARIATION == InputType.TYPE_TEXT_VARIATION_PASSWORD) {
            box.endIconMode = TextInputLayout.END_ICON_PASSWORD_TOGGLE
        }
        addView(box, LayoutParams(-1, -2))
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { box.error = null }
            override fun afterTextChanged(s: Editable?) {}
        })
    }
    fun showError(message: String) {
        box.error = message
        input.requestFocus()
    }
}
