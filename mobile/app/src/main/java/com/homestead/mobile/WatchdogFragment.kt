package com.homestead.mobile

class WatchdogFragment : WebViewFragment() {

    companion object {
        private const val WATCHDOG_URL = "https://joshuas-macbook-air.tail84bb3b.ts.net:8443"
    }

    override fun getUrl(): String = WATCHDOG_URL
    override fun getTabName(): String = "Watchdog"
}
