//! The notch — a frameless strip stuck to the top edge of a screen, showing
//! what is downloading and letting the user get back to the app.
//!
//! Every bit of window handling lives here rather than in the frontend. Driving
//! it from JavaScript would mean granting the webview `core:window:allow-show`,
//! `allow-hide`, `allow-set-position` and `allow-set-size`. A capability can be
//! scoped to one window label, but those commands take a *label argument*, so a
//! webview holding them could aim them at the main window too. Keeping the
//! power in Rust means the only window any of this can touch is the notch.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// Window label. Also what `tauri_plugin_window_state` is told to leave alone:
/// a restored geometry would fight the placement below, and the notch's size is
/// decided by its mode rather than by the user.
pub const LABEL: &str = "island";

/// How wide the concave fillets at each side are, in logical pixels. The
/// frontend draws them, but the window has to be wide enough to contain them —
/// see `Mode::size`, which already includes both.
const WING: f64 = 16.0;

/// Where the notch is parked, in physical pixels.
///
/// The monitor is identified by its origin rather than by name: `Monitor::name`
/// is optional and, on Windows, changes when a display is re-detected, which
/// would silently lose the saved spot. An origin that no longer matches any
/// monitor means the display is gone, and falling back is the right answer
/// anyway.
#[derive(Clone, Copy, Serialize, Deserialize)]
struct Spot {
    origin_x: i32,
    origin_y: i32,
    /// Horizontal centre of the notch. Stored as a centre, not a left edge, so
    /// the notch stays put when a mode change makes it wider or narrower.
    center_x: i32,
}

/// Last known spot, kept in memory so every show and resize can honour it
/// without touching the disk. Written out only when a drag ends.
static SPOT: Mutex<Option<Spot>> = Mutex::new(None);

/// How much of the notch is on screen. Chosen by the UI, which knows what it
/// has to say; this side only turns it into a window size.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Nothing running — just the app's mark, so the notch can be grabbed and
    /// moved before there is any download to look at.
    Compact,
    /// A download in progress, or one that has just finished.
    Active,
    /// The panel is open, listing everything that is running.
    Expanded,
}

impl Mode {
    /// Logical size of the window for this mode.
    ///
    /// The window is only as large as the drawn shape. It is transparent and
    /// always on top, so every pixel of slack would swallow clicks meant for
    /// whatever is behind it — a browser's tab strip, which sits exactly here.
    fn size(self) -> (f64, f64) {
        match self {
            Mode::Compact => (248.0 + WING * 2.0, 40.0),
            Mode::Active => (520.0 + WING * 2.0, 56.0),
            Mode::Expanded => (560.0 + WING * 2.0, 404.0),
        }
    }
}

/// What the notch shows. Built by the UI, which is where the job list lives;
/// this side only forwards it.
#[derive(Clone, Serialize, Deserialize)]
pub struct IslandState {
    pub mode: Mode,
    /// "idle", "downloading" or "done". A string rather than an enum because
    /// nothing on this side branches on it.
    pub phase: String,
    /// "light" or "dark", already resolved by the UI. The notch follows the
    /// app's theme, and asking the OS here would risk a second answer that
    /// disagrees with the window behind it.
    pub theme: String,
    /// Accent name, applied by the notch as a `data-accent` attribute.
    pub accent: String,
    /// File being downloaded, already reduced to a bare name by the UI.
    pub name: String,
    pub percent: f64,
    pub speed_bytes: u64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    /// Human-readable time left, or empty when it cannot be worked out.
    pub eta: String,
    /// Jobs downloading right now, this one included. Anything above 1 is shown
    /// as "+N lagi" so the notch never implies it is the whole picture.
    pub active_count: usize,
    /// What the expanded panel lists. Empty in the other modes, so the common
    /// case doesn't pay for serialising a list nobody will look at.
    pub items: Vec<IslandItem>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct IslandItem {
    pub id: String,
    pub name: String,
    pub percent: f64,
    pub speed_bytes: u64,
    pub status: String,
}

/// Builds the notch, hidden. Called once at startup so the window is ready
/// before the first download rather than being created mid-progress, which
/// would show an empty frame while the webview booted.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    if let Ok(mut spot) = SPOT.lock() {
        *spot = load_spot(app);
    }

    let (width, height) = Mode::Compact.size();
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("island.html".into()))
        .title("Download Engine")
        .inner_size(width, height)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        // Keeps it out of the taskbar and out of Alt-Tab: it is a readout, not
        // a window the user navigates to.
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .build()?;

    place(&window, Mode::Compact);
    Ok(())
}

/// Reads the saved spot without letting a poisoned lock take the app down: a
/// notch in the wrong place is a far smaller problem than a panic.
fn current_spot() -> Option<Spot> {
    SPOT.lock().ok().and_then(|spot| *spot)
}

/// The monitor the notch belongs on: the one its saved spot names, falling back
/// to whichever the main window is on.
fn target_monitor(window: &WebviewWindow, spot: Option<Spot>) -> Option<Monitor> {
    if let Some(spot) = spot {
        if let Ok(monitors) = window.available_monitors() {
            let found = monitors.into_iter().find(|m| {
                let p = m.position();
                p.x == spot.origin_x && p.y == spot.origin_y
            });
            if found.is_some() {
                return found;
            }
        }
    }

    // On a multi-screen desk the notch belongs on the screen being looked at,
    // which is the one holding the window the user interacts with.
    window
        .app_handle()
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())
}

/// Sizes the notch for `mode` and parks it against the top edge of its monitor.
///
/// Re-run on every show and every mode change rather than only at startup:
/// laptops change resolution when a monitor is plugged in, and a position
/// worked out at launch would leave the notch off-screen afterwards — where it
/// could not be dragged back, since it has no title bar to grab.
fn place(window: &WebviewWindow, mode: Mode) {
    let (logical_width, logical_height) = mode.size();
    let _ = window.set_size(LogicalSize::new(logical_width, logical_height));

    let spot = current_spot();
    let Some(monitor) = target_monitor(window, spot) else {
        // Without monitor geometry there is no sensible top edge, and guessing
        // one risks parking the notch where it cannot be reached.
        return;
    };

    let scale = monitor.scale_factor();
    let origin = *monitor.position();
    let size = *monitor.size();
    let width = (logical_width * scale).round() as i32;

    // A spot saved on a different monitor is not meaningful here, so it is only
    // honoured when the monitor matches; otherwise the notch starts centred.
    let center_x = match spot {
        Some(s) if s.origin_x == origin.x && s.origin_y == origin.y => s.center_x,
        _ => origin.x + size.width as i32 / 2,
    };

    let x = clamp_left(center_x - width / 2, width, origin.x, size.width);
    // Flush with the top edge: a notch with a gap above it reads as a floating
    // panel that someone mispositioned.
    let _ = window.set_position(PhysicalPosition::new(x, origin.y));
}

/// Keeps the whole notch on its monitor, so no part of it lands in the gap
/// between two screens or past the outer edge.
fn clamp_left(left: i32, width: i32, origin_x: i32, monitor_width: u32) -> i32 {
    let max = origin_x + monitor_width as i32 - width;
    // A notch wider than the screen would make `max` smaller than the left
    // edge; pinning to the left edge then at least keeps its start visible.
    if max <= origin_x {
        return origin_x;
    }
    left.clamp(origin_x, max)
}

/// Shows the notch with fresh figures, or hides it when there is nothing to
/// show and the user has asked for it to stay out of the way.
///
/// One command for both so the UI has a single thing to call on every change:
/// `Some` means "this is the state", `None` means "get off the screen".
#[tauri::command]
pub fn island_update(app: AppHandle, state: Option<IslandState>) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };

    let Some(state) = state else {
        let _ = window.hide();
        return;
    };

    let mode = state.mode;
    // Pushed before the window is sized and shown, so it never appears holding
    // the figures from the previous download for a frame.
    let _ = window.emit_to(LABEL, "island-state", state);

    place(&window, mode);
    if !window.is_visible().unwrap_or(false) {
        let _ = window.show();
    }
}

/// Moves the notch to follow a cursor being dragged across the desktop.
///
/// The frontend tracks the pointer itself rather than handing the window to the
/// OS drag loop: the notch only ever moves sideways along a top edge, and a
/// free OS drag would have to be snapped back afterwards — for which Tauri
/// offers no drag-finished event to hang the snap on.
///
/// `screen_x` and `screen_y` are physical pixels, already scaled by the caller.
#[tauri::command]
pub fn island_drag(app: AppHandle, screen_x: f64, screen_y: f64) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };

    // The monitor under the *cursor*, not under the window: that is what makes
    // dragging onto a second screen work — the notch follows the pointer across
    // the boundary instead of clinging to the screen it started on.
    let monitor = match app.monitor_from_point(screen_x, screen_y) {
        Ok(Some(monitor)) => monitor,
        _ => return,
    };

    let origin = *monitor.position();
    let size = *monitor.size();
    let Ok(outer) = window.outer_size() else { return };
    let width = outer.width as i32;
    if width == 0 {
        return;
    }

    let x = clamp_left(screen_x.round() as i32 - width / 2, width, origin.x, size.width);
    let _ = window.set_position(PhysicalPosition::new(x, origin.y));

    if let Ok(mut spot) = SPOT.lock() {
        *spot = Some(Spot {
            origin_x: origin.x,
            origin_y: origin.y,
            // The clamped centre, not the cursor's: near a screen edge the
            // notch stops before the pointer does, and saving the pointer
            // would make it jump on the next show.
            center_x: x + width / 2,
        });
    }
}

/// Writes the spot the drag ended on, so the notch comes back there next time.
///
/// Only on release, not on every move: a drag across a wide desktop produces
/// hundreds of positions, and none of the intermediate ones is worth a write.
#[tauri::command]
pub fn island_drag_end(app: AppHandle) {
    let Some(spot) = current_spot() else { return };
    save_spot(&app, spot);
}

/// Hands an action the notch cannot perform itself to the main window.
///
/// Pausing a job, resuming it or revealing a finished file all need the job
/// list and the opener permission, both of which live in the main window. One
/// forwarding command keeps the notch's own capability down to listening for
/// events.
#[tauri::command]
pub fn island_action(app: AppHandle, action: String, job_id: Option<String>) {
    let _ = app.emit_to("main", "island-action", (action, job_id));
}

/// Brings the main window forward, for the notch's own click handler.
#[tauri::command]
pub fn island_reveal_main(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

const SPOT_FILE: &str = "island-spot.json";

fn spot_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(SPOT_FILE))
}

/// The saved spot, or `None` when there isn't one or it can't be read.
///
/// A missing or unreadable file is an ordinary first run, not an error worth
/// reporting: the notch simply starts centred.
fn load_spot(app: &AppHandle) -> Option<Spot> {
    let raw = std::fs::read_to_string(spot_path(app)?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_spot(app: &AppHandle, spot: Spot) {
    let Some(path) = spot_path(app) else { return };
    let Ok(raw) = serde_json::to_string(&spot) else {
        return;
    };
    // A failed write costs the user one remembered position, which is not worth
    // interrupting them over.
    let _ = std::fs::write(path, raw);
}
