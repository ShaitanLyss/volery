package com.volery.phone

import android.app.Activity
import android.content.Context
import android.content.Intent

/** Open another screen with a soft cross-fade, so moving between the home,
 *  settings and the viewer feels like one warm surface rather than a hard
 *  switch. */
fun Context.open(intent: Intent) {
    startActivity(intent)
    (this as? Activity)?.overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
}
