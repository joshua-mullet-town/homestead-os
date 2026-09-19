package com.homestead.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.LauncherApps
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Process
import android.os.UserManager
import android.text.format.DateFormat
import android.view.GestureDetector
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Phone mode — the "use my phone like a normal phone" home screen.
 *
 * Deliberately thin: the system wallpaper shows through (MainActivity sets
 * FLAG_SHOW_WALLPAPER and a transparent background while this is the active
 * home fragment), so all this renders is a clock, the date, and a grid of the
 * apps Joshua is most likely to want right now.
 *
 * The full app drawer is NOT duplicated here — swiping up hands off to
 * MainActivity's existing drawer overlay, which owns search + all apps.
 *
 * Replaced the old SmartAppsFragment, which was instantiated but never attached
 * to any container (dead since the presenter became the home screen).
 */
class PhoneModeFragment : Fragment() {

    /** Set by MainActivity — opens the full app drawer (search + all apps). */
    var onSwipeUp: (() -> Unit)? = null

    /** Set by MainActivity — launches an app by package name. */
    var onAppClick: ((String) -> Unit)? = null

    /** Set by MainActivity — opens system App Info for a package. */
    var onAppInfo: ((String) -> Unit)? = null

    /** Set by MainActivity — opens the clock app (tap the time). */
    var onClockClick: (() -> Unit)? = null

    /** Set by MainActivity — opens the calendar (tap the date). */
    var onDateClick: (() -> Unit)? = null

    /** Set by MainActivity — opens the weather app (tap anywhere on the forecast). */
    var onWeatherClick: (() -> Unit)? = null

    private var clock: PhoneModeClock? = null

    /** The upper-right forecast ribbon. */
    private var weather: PhoneModeWeather? = null

    /** Packages currently drawn in the grid, left-to-right. Drives drag-reorder. */
    private var shownPackages: List<String> = emptyList()

    /** Non-null while a "Move" is armed and waiting for its destination tap. */
    private var pendingMovePackage: String? = null

    /** The move-highlight state the grid was last drawn with. */
    private var lastRenderedMovePackage: String? = null

    private var cachedApps: List<Triple<String, String, Drawable>>? = null
    private var cachedAppsAt: Long = 0L
    private var appsGrid: GridLayout? = null
    private var trayRow: LinearLayout? = null

    private val tickHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            updateClock()
            // Re-post on the next minute boundary so the clock flips exactly on time
            val now = System.currentTimeMillis()
            tickHandler.postDelayed(this, 60_000L - (now % 60_000L))
        }
    }

    companion object {
        private const val TAG = "PhoneModeFragment"
        private const val COLUMNS = 5
        /** Two full rows of four. Favourites lead; smart picks fill the rest. */
        private const val MAX_APPS = 10
        /** Vertical travel (px-independent) before an upward drag counts as "open the drawer". */
        private const val SWIPE_THRESHOLD_DP = 60f
        private const val TRAY_PREFS = "homestead_phone_tray"
        private const val TRAY_KEY = "package_names"
        private const val TRAY_MAX = 5
        /** How long the launchable-app list stays cached. */
        private const val APP_CACHE_MS = 60_000L
        /** First-run seed; only those actually installed are used. */
        private val TRAY_DEFAULTS = listOf(
            "com.google.android.dialer",
            "com.google.android.apps.messaging",
            "com.google.android.GoogleCamera",
            "com.google.android.apps.maps",
            "com.android.chrome",
        )
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        val ctx = requireContext()
        val dp = resources.displayMetrics.density

        val root = FrameLayout(ctx).apply {
            // Transparent on purpose — the system wallpaper composites behind us.
            setBackgroundColor(Color.TRANSPARENT)
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        val column = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.START
            setPadding((22 * dp).toInt(), (76 * dp).toInt(), (22 * dp).toInt(), (28 * dp).toInt())
        }

        // ── CLOCK + DATE ──
        // Custom view: stacked oversized time with the date beneath. Drawn on a
        // Canvas so the two time lines can sit tight against each other.
        clock = PhoneModeClock(ctx).apply {
            isClickable = true
            // Time half opens the clock, date half opens the calendar. The view
            // reports where its own blocks ended so the split follows the actual
            // rendered layout rather than a guessed pixel offset.
            setOnClickListener { }
            setOnTouchListener { v, event ->
                if (event.actionMasked == MotionEvent.ACTION_UP) {
                    val c = v as PhoneModeClock
                    if (c.isTimeRegion(event.y)) onClockClick?.invoke() else onDateClick?.invoke()
                    v.performClick()
                }
                true
            }
        }
        column.addView(clock, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ))

        // ── TOP APPS ──
        appsGrid = GridLayout(ctx).apply {
            columnCount = COLUMNS
            alignmentMode = GridLayout.ALIGN_BOUNDS
        }
        column.addView(appsGrid, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = (44 * dp).toInt() })

        root.addView(column, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.TOP })

        // ── WEATHER (upper right) ──
        // The corner beside the clock was empty; this fills it with a six-day
        // ribbon. Added AFTER the column so it draws on top — the clock column
        // is MATCH_PARENT wide and would otherwise cover it.
        weather = PhoneModeWeather(ctx).apply {
            // The whole corner is one target — Josh asked to tap "any part of
            // that". Consuming the touch here also stops the tap falling through
            // to the root gesture detector, which would treat it as empty space.
            isClickable = true
            setOnClickListener { onWeatherClick?.invoke() }
        }
        root.addView(weather, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            topMargin = (78 * dp).toInt()
            rightMargin = (18 * dp).toInt()
        })
        loadWeather()

        // ── BOTTOM TRAY ──
        // Josh's "special tray" — camera, messages, maps, whatever he pins. Kept
        // separate from the main grid on purpose: the grid re-ranks itself as his
        // habits shift, while the tray is fixed and always in thumb reach.
        trayRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding((10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt())
            background = GradientDrawable().apply {
                setColor(Color.argb(70, 0, 0, 0))
                cornerRadius = 26 * dp
            }
        }
        root.addView(trayRow, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            bottomMargin = (26 * dp).toInt()
        })

        // ── GESTURES: swipe up = app drawer, long-press = wallpaper picker ──
        // Both go through one GestureDetector on purpose. Hand-rolling the swipe
        // with a touch listener meant consuming ACTION_DOWN, which silently
        // starved the long-press so the wallpaper picker never fired.
        val threshold = SWIPE_THRESHOLD_DP * dp
        val gestures = GestureDetector(ctx, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent) = true

            override fun onSingleTapUp(e: MotionEvent): Boolean {
                // Tapping empty space cancels an armed Move, so a mis-tap can't
                // leave a tile dimmed and waiting forever.
                if (pendingMovePackage != null) {
                    pendingMovePackage = null
                    refreshApps()
                    return true
                }
                return false
            }

            override fun onLongPress(e: MotionEvent) {
                if (pendingMovePackage != null) {
                    pendingMovePackage = null
                    refreshApps()
                    return
                }
                openWallpaperPicker()
            }

            override fun onFling(
                e1: MotionEvent?, e2: MotionEvent,
                velocityX: Float, velocityY: Float
            ): Boolean {
                val dy = (e1?.y ?: return false) - e2.y
                val dx = Math.abs(e2.x - e1.x)
                // Upward, and more vertical than horizontal, so it can't be
                // confused with the edge-swipe gestures the rest of the app uses.
                if (dy > threshold && dy > dx) {
                    onSwipeUp?.invoke()
                    return true
                }
                return false
            }
        })
        root.setOnTouchListener { _, event -> gestures.onTouchEvent(event) }

        // Long-press empty space opens the system wallpaper picker — the same
        // gesture every Android launcher uses. Josh, 2026-08-29: "let me choose
        // the background". His wallpaper is whatever he sets here; we just show
        // it through (FLAG_SHOW_WALLPAPER), so his choice always wins.
        updateClock()
        return root
    }

    /**
     * Draw the cached forecast at once, then refresh from the network if it's
     * stale. Cache-first on purpose: the corner should never be an empty gap
     * while a request is in flight, and this screen is opened constantly.
     */
    private fun loadWeather() {
        val ctx = context ?: return
        val view = weather ?: return
        WeatherRepository.cached(ctx)?.let { view.setForecast(it) }
        WeatherRepository.load(ctx) { forecast ->
            // Fetch completes on a background thread; hop to the main thread,
            // and only if we're still attached.
            view.post {
                if (isAdded) weather?.setForecast(forecast)
            }
        }
    }

    private fun openWallpaperPicker() {
        val ctx = context ?: return
        // ACTION_SET_WALLPAPER is the documented picker intent; the chooser makes
        // sure we land somewhere sane on OEM ROMs that ship their own gallery.
        val intent = Intent(Intent.ACTION_SET_WALLPAPER)
        try {
            startActivity(Intent.createChooser(intent, "Set wallpaper"))
        } catch (e: Exception) {
            Toast.makeText(ctx, "No wallpaper picker on this device", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onResume() {
        super.onResume()
        updateClock()
        // He may have changed his wallpaper while we were away.
        clock?.refreshContrast()
        refreshApps()
        refreshTray()
        // Picks up a new day's forecast when he comes back to the screen.
        loadWeather()
        tickHandler.removeCallbacks(tick)
        // First tick lands on the next minute boundary, then every minute after.
        val now = System.currentTimeMillis()
        tickHandler.postDelayed(tick, 60_000L - (now % 60_000L))
    }

    override fun onPause() {
        super.onPause()
        tickHandler.removeCallbacks(tick)
    }

    private fun updateClock() {
        clock?.refresh()
    }

    /**
     * Fill the grid: every pinned favourite first, then smart-ranked apps.
     *
     * Josh, 2026-08-29: "have all the favorites". Favourites are his explicit
     * picks, so they are never dropped or reordered by the scorer — they lead,
     * in the order he pinned them. Smart-ranked apps (most likely right now,
     * by recency x time-of-day) then fill whatever room is left, skipping
     * anything already shown as a favourite.
     *
     * Degrades cleanly: no usage permission or no history yet -> favourites
     * alone; no favourites -> smart apps alone; neither -> the grid is hidden
     * rather than left as an empty gap under the clock.
     */
    fun refreshApps() {
        val ctx = context ?: return
        val grid = appsGrid ?: return

        val installed = loadLaunchableApps(ctx)
        if (installed.isEmpty()) return
        val byPackage = installed.associateBy { it.first }

        // Favourites lead, de-duped, and only those actually still installed.
        val favourites = favoritePackages(ctx).filter { it in byPackage }.distinct()

        val room = (MAX_APPS - favourites.size).coerceAtLeast(0)
        val ranked = if (room > 0 && SmartAppScoring.hasUsagePermission(ctx)) {
            // Ask for extra, then drop favourites — the scorer doesn't know about them.
            SmartAppScoring.rankPackages(ctx, byPackage.keys, MAX_APPS + favourites.size)
                .filter { it !in favourites }
                .take(room)
        } else {
            emptyList()
        }

        val packages = (favourites + ranked).filter { it in byPackage }

        // Rebuilding ten tiles costs real frame time, and refreshApps() runs on
        // every mode switch. When nothing has actually changed there is nothing
        // to redraw — skipping it keeps the switch animation smooth.
        //
        // The move-highlight is part of "changed": a tile dims when a Move is
        // armed and un-dims when it's cancelled, and in both cases the package
        // list itself is identical.
        val unchanged = packages == shownPackages &&
            grid.childCount == packages.size &&
            pendingMovePackage == lastRenderedMovePackage
        if (unchanged) return

        shownPackages = packages
        lastRenderedMovePackage = pendingMovePackage
        grid.visibility = if (packages.isEmpty()) View.GONE else View.VISIBLE
        if (packages.isEmpty()) return

        grid.removeAllViews()
        packages.forEach { pkg ->
            val app = byPackage[pkg] ?: return@forEach
            grid.addView(buildTile(pkg, app.second, app.third))
        }
    }

    /**
     * Long-press menu for a grid tile — same shape as the app drawer's menu.
     *
     * "Move" doesn't drag: it arms move-mode, and the next tile he taps is the
     * destination. That avoids a drag gesture competing with the swipe-up that
     * opens the drawer, and it's the flow he described.
     */
    private fun showTileMenu(anchor: View, pkg: String) {
        val ctx = context ?: return
        val isFav = favoritePackages(ctx).contains(pkg)

        val popup = android.widget.PopupMenu(ctx, anchor)
        popup.menu.add(0, 1, 0, "Move")
        popup.menu.add(0, 2, 1, if (isFav) "Remove from Favorites" else "Add to Favorites")
        popup.menu.add(0, 3, 2, "Add to bottom tray")
        popup.menu.add(0, 4, 3, "App Info")
        popup.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> {
                    pendingMovePackage = pkg
                    Toast.makeText(ctx, "Tap where you want it", Toast.LENGTH_SHORT).show()
                    refreshApps()
                    true
                }
                2 -> {
                    val current = rawFavourites(ctx).toMutableList()
                    if (isFav) current.remove(pkg) else current.add(pkg)
                    saveFavourites(ctx, current)
                    refreshApps()
                    true
                }
                3 -> { addToTray(pkg); true }
                4 -> { onAppInfo?.invoke(pkg); true }
                else -> false
            }
        }
        popup.show()
    }

    /**
     * Commit a drag: move [from] to [to] in the visible order and persist it.
     *
     * Persisting means writing the whole visible arrangement into the favourites
     * list — so an app the scorer happened to surface becomes pinned the moment
     * Joshua drags it somewhere deliberate. That's the behaviour he'd expect:
     * once you arrange a screen by hand, it should stay arranged rather than get
     * silently re-sorted on the next refresh.
     */
    private fun commitReorder(from: Int, to: Int) {
        val ctx = context ?: return
        val current = shownPackages.toMutableList()
        if (from !in current.indices || to !in current.indices || from == to) return

        current.add(to, current.removeAt(from))
        shownPackages = current

        // Keep any work-profile favourites we filtered out of the grid, or a
        // reorder here would quietly delete them from his pinned list.
        val preserved = rawFavourites(ctx).filter { it.endsWith(":work") }
        val arr = org.json.JSONArray()
        (current + preserved).forEach { arr.put(it) }
        ctx.getSharedPreferences("homestead_quick_apps", Context.MODE_PRIVATE)
            .edit().putString("package_names", arr.toString()).apply()

        refreshApps()
    }

    private fun buildTile(pkg: String, label: String, icon: Drawable): View {
        val ctx = requireContext()
        val dp = resources.displayMetrics.density

        val tile = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding((6 * dp).toInt(), (10 * dp).toInt(), (6 * dp).toInt(), (10 * dp).toInt())
            isClickable = true
            isFocusable = true
            setOnClickListener {
                val moving = pendingMovePackage
                if (moving == null) {
                    onAppClick?.invoke(pkg)
                } else {
                    // Second tap of a move: this tile's slot is the destination.
                    pendingMovePackage = null
                    val from = shownPackages.indexOf(moving)
                    val to = shownPackages.indexOf(pkg)
                    if (from >= 0 && to >= 0) commitReorder(from, to) else refreshApps()
                }
            }

            // Long-press opens a menu, matching the app-drawer's behaviour rather
            // than grabbing the icon straight away. Josh, 2026-08-29: the menu
            // should offer Move, and only then does he pick the destination.
            setOnLongClickListener { v ->
                showTileMenu(v, pkg)
                true
            }

            // Dim + shrink the armed tile so it's obvious which one is moving.
            if (pkg == pendingMovePackage) {
                alpha = 0.45f
                scaleX = 0.88f
                scaleY = 0.88f
            }
            layoutParams = GridLayout.LayoutParams().apply {
                width = (63 * dp).toInt()
                height = ViewGroup.LayoutParams.WRAP_CONTENT
            }
        }

        tile.addView(ImageView(ctx).apply {
            setImageDrawable(icon)
            layoutParams = LinearLayout.LayoutParams((44 * dp).toInt(), (44 * dp).toInt())
        })

        tile.addView(TextView(ctx).apply {
            text = label
            textSize = 11f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            setShadowLayer(5f * dp, 0f, 1f * dp, Color.argb(160, 0, 0, 0))
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = (6 * dp).toInt() })

        return tile
    }

    /**
     * (packageName, label, icon) for every launchable app in the personal profile.
     *
     * Cached: querying every launcher activity and loading its badged icon costs
     * roughly 50-100ms, and running that on the UI thread immediately before the
     * mode animation is what made the switch visibly hesitate before starting.
     * The set of installed apps barely changes, so a short-lived cache is safe.
     */
    private fun loadLaunchableApps(ctx: Context): List<Triple<String, String, Drawable>> {
        val cached = cachedApps
        if (cached != null && System.currentTimeMillis() - cachedAppsAt < APP_CACHE_MS) {
            return cached
        }
        val fresh = queryLaunchableApps(ctx)
        if (fresh.isNotEmpty()) {
            cachedApps = fresh
            cachedAppsAt = System.currentTimeMillis()
        }
        return fresh
    }

    private fun queryLaunchableApps(ctx: Context): List<Triple<String, String, Drawable>> {
        return try {
            val launcherApps = ctx.getSystemService(Context.LAUNCHER_APPS_SERVICE) as LauncherApps
            val myUser = Process.myUserHandle()
            launcherApps.getActivityList(null, myUser)
                .filter { it.componentName.packageName != ctx.packageName }
                .map {
                    Triple(
                        it.componentName.packageName,
                        it.label.toString(),
                        it.getBadgedIcon(0)
                    )
                }
                // One entry per package — some apps expose several launcher activities.
                .distinctBy { it.first }
        } catch (e: Exception) {
            emptyList()
        }
    }

    /**
     * Fill the bottom tray from its own pref list.
     *
     * Seeded on first run with whatever of a sensible default set he actually
     * has installed (phone, messages, camera, maps, browser) so the tray is
     * never an empty bar — he can then swap them out by long-pressing a tile in
     * the drawer, same as favourites.
     */
    private fun refreshTray() {
        val ctx = context ?: return
        val row = trayRow ?: return
        val installed = loadLaunchableApps(ctx).associateBy { it.first }

        var packages = trayPackages(ctx).filter { it in installed }
        if (packages.isEmpty()) {
            packages = TRAY_DEFAULTS.filter { it in installed }.take(TRAY_MAX)
            if (packages.isNotEmpty()) saveTray(ctx, packages)
        }

        row.visibility = if (packages.isEmpty()) View.GONE else View.VISIBLE
        row.removeAllViews()
        packages.take(TRAY_MAX).forEach { pkg ->
            val app = installed[pkg] ?: return@forEach
            row.addView(buildTrayTile(pkg, app.third))
        }
    }

    /** A tray tile: icon only, no label — it's a dock, not a grid. */
    private fun buildTrayTile(pkg: String, icon: Drawable): View {
        val ctx = requireContext()
        val dp = resources.displayMetrics.density
        return ImageView(ctx).apply {
            setImageDrawable(icon)
            layoutParams = LinearLayout.LayoutParams((48 * dp).toInt(), (48 * dp).toInt())
                .apply { marginStart = (9 * dp).toInt(); marginEnd = (9 * dp).toInt() }
            isClickable = true
            setOnClickListener { onAppClick?.invoke(pkg) }
            setOnLongClickListener {
                // Long-press removes it from the tray — the inverse of adding.
                val ctx2 = context ?: return@setOnLongClickListener true
                saveTray(ctx2, trayPackages(ctx2).filter { it != pkg })
                refreshTray()
                Toast.makeText(ctx2, "Removed from tray", Toast.LENGTH_SHORT).show()
                true
            }
        }
    }

    private fun trayPackages(ctx: Context): List<String> {
        val raw = ctx.getSharedPreferences(TRAY_PREFS, Context.MODE_PRIVATE)
            .getString(TRAY_KEY, null) ?: return emptyList()
        return try {
            val arr = org.json.JSONArray(raw)
            (0 until arr.length()).map { arr.getString(it) }
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun saveTray(ctx: Context, packages: List<String>) {
        val arr = org.json.JSONArray()
        packages.distinct().take(TRAY_MAX).forEach { arr.put(it) }
        ctx.getSharedPreferences(TRAY_PREFS, Context.MODE_PRIVATE)
            .edit().putString(TRAY_KEY, arr.toString()).apply()
    }

    /** Add an app to the tray (called from the drawer's long-press menu). */
    fun addToTray(pkg: String) {
        val ctx = context ?: return
        saveTray(ctx, listOf(pkg) + trayPackages(ctx).filter { it != pkg })
        refreshTray()
    }

    /** Every stored favourite, work-profile entries included. */
    private fun rawFavourites(ctx: Context): List<String> {
        val raw = ctx.getSharedPreferences("homestead_quick_apps", Context.MODE_PRIVATE)
            .getString("package_names", null) ?: return emptyList()
        return try {
            val arr = org.json.JSONArray(raw)
            (0 until arr.length()).map { arr.getString(it) }
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun saveFavourites(ctx: Context, packages: List<String>) {
        val arr = org.json.JSONArray()
        packages.distinct().forEach { arr.put(it) }
        ctx.getSharedPreferences("homestead_quick_apps", Context.MODE_PRIVATE)
            .edit().putString("package_names", arr.toString()).apply()
    }

    /** Joshua's manually-pinned apps — shared with the drawer's favourites. */
    private fun favoritePackages(ctx: Context): List<String> {
        val raw = ctx.getSharedPreferences("homestead_quick_apps", Context.MODE_PRIVATE)
            .getString("package_names", null) ?: return emptyList()
        return try {
            val arr = org.json.JSONArray(raw)
            // Favourites are stored with a ":work" suffix for work-profile entries;
            // Phone mode only shows personal-profile apps, so strip and drop those.
            (0 until arr.length())
                .map { arr.getString(it) }
                .filter { !it.endsWith(":work") }
        } catch (e: Exception) {
            emptyList()
        }
    }
}
