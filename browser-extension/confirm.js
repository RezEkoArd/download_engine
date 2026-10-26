/**
 * The "take this one?" question, shown under the toolbar icon while the
 * browser's own download sits paused. background.js points the action popup
 * here, one download at a time.
 *
 * It decides nothing itself: every outcome is a message back to the service
 * worker, which owns the paused download and is the only place that may cancel
 * or resume it. Dismissing the popup is a decision too — see the port below.
 */

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const downloadId = Number(params.get("id"));

// Matches the options page and popup so the three never look like different
// extensions.
chrome.storage.local.get("theme").then(({ theme }) => {
  document.documentElement.classList.toggle("dark", (theme ?? "dark") === "dark");
});

/** Already answered — stops a second click from sending a second decision. */
let settled = false;

/**
 * Held open for as long as this popup is on screen.
 *
 * A closing popup fires no event anyone can listen for, so the service worker
 * watches this port instead: clicking outside the popup drops it, and that is
 * how "the user walked away" becomes an answer rather than a download left
 * paused forever. It also keeps the worker alive while the question is up,
 * which MV3 would otherwise be free to end.
 */
chrome.runtime.connect({ name: `confirm:${downloadId}` });

/* ---------- what is being downloaded ---------- */

function formatSize(bytes) {
  if (!bytes || bytes < 0) return "ukuran belum diketahui";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The last path segment, which is what the browser would have saved it as. */
function baseName(path) {
  if (!path) return "";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

/** The last path segment of a URL, for before the browser has picked a name. */
function nameFromUrl(url) {
  try {
    return decodeURIComponent(baseName(new URL(url).pathname));
  } catch {
    return "";
  }
}

function render(item) {
  const url = item.finalUrl || item.url || "";

  const name = baseName(item.filename) || nameFromUrl(url) || "(nama belum diketahui)";
  $("name").textContent = name;
  $("name").title = name;

  // `totalBytes` is 0 until the response headers arrive, and stays 0 for a
  // server that sends no Content-Length — "belum diketahui" is honest there,
  // where "0 B" would read as an empty file.
  $("size").textContent = formatSize(item.totalBytes || item.fileSize);

  try {
    $("host").textContent = new URL(url).host;
  } catch {
    $("host").textContent = "—";
  }

  $("url").textContent = url;
  $("url").title = url;
}

async function load() {
  let items = [];
  try {
    items = (await chrome.downloads?.search({ id: downloadId })) ?? [];
  } catch {
    // The permission was revoked between the pause and this page opening.
  }
  if (items.length) render(items[0]);
}

// The size and filename usually arrive after `onCreated` fired, so the dialog
// opens with blanks and fills in rather than waiting for complete data it may
// never get.
// Guarded because `chrome.downloads` exists only while the optional permission
// is held, and it can be revoked from the options page while this dialog is
// open. Without the guard the script would throw here and the buttons below
// would never be wired up, leaving a dialog that cannot be answered.
if (chrome.downloads) {
  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.id !== downloadId) return;
    void load();
  });
}

void load();

/* ---------- the decision ---------- */

async function decide(choice) {
  if (settled) return;
  settled = true;

  if ($("dontAsk").checked && choice === "engine") {
    await chrome.storage.local.set({ confirmIntercept: false });
  }

  $("status").textContent = choice === "engine" ? "Mengirim ke Download Engine…" : "Dikembalikan ke browser…";
  $("engine").disabled = true;
  $("browser").disabled = true;

  // Marked before the window closes: background.js reads it to tell a real
  // answer apart from the window simply being dismissed.
  try {
    await chrome.runtime.sendMessage({ type: "intercept-decision", id: downloadId, choice });
  } catch {
    // The worker was torn down mid-message. It will find the download still
    // paused on its next wake-up and resume it, so the browser keeps the file.
  }

  window.close();
}

$("engine").addEventListener("click", () => void decide("engine"));
$("browser").addEventListener("click", () => void decide("browser"));

// Enter takes the engine, Esc leaves it to the browser — the same defaults the
// buttons present, for anyone who never reaches for the mouse.
document.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void decide("engine");
  if (event.key === "Escape") void decide("browser");
});
