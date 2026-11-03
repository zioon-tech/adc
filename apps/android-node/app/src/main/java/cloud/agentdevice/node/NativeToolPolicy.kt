package cloud.agentdevice.node

/** Both discovery and execution use this mapping. New tools must declare a local permission. */
object NativeToolPolicy {
    fun group(tool: String): CapabilityGroup = when (tool) {
        "device.info.get", "device.storage.get", "display.status", "audio.status" ->
            CapabilityGroup.DEVICE_STATUS
        "audio.volume.set" -> CapabilityGroup.AUDIO_CONTROL
        "device.vibrate" -> CapabilityGroup.VIBRATION
        "app.open" -> CapabilityGroup.APP_LAUNCH
        "flashlight.status", "flashlight.set" -> CapabilityGroup.FLASHLIGHT
        else -> throw IllegalArgumentException("Unknown native tool: $tool")
    }
}
