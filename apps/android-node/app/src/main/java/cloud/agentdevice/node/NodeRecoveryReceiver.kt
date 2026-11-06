package cloud.agentdevice.node

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Android permits foreground service recovery after replacement of this package. */
class NodeRecoveryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) NodeService.restoreDesired(context)
    }
}
