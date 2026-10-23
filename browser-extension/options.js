const BRIDGE_ORIGIN = "http://127.0.0.1:47283";
const TOKEN_HEADER = "x-download-engine-token";

const $ = (id) => document.getElementById(id);

const tokenInput = $("token");
const statusEl = $("status");
const authTag = $("authTag");
const connBadge = $("connBadge");
const connText = $("connText");
const cookiesCheckbox = $("cookies");
const cookieState = $("cookieState");
const interceptCheckbox = $("intercept");
const interceptState = $("interceptState");
const logBody = $("logBody");

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = kind;
}

function icon(name) {
  return `<svg class="icon"><use href="#i-${name}" /></svg>`;
}

let toastTimer;
function showToast(message, ok = true) {
  $("toastMsg").textContent = message;
  $("toast").className = ok ? "toast" : "toast is-bad";
  $("toastIcon").setAttribute("href", ok ? "#i-check" : "#i-x");
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 3000);
}

/* ---------- theme ---------- */

/**
 * Stored rather than read from `prefers-color-scheme`, because the mock-up this
 * page follows is dark and the OS preference would override that choice every
 * time the page reopened.
 */
async function loadTheme() {
  const { theme } = await chrome.storage.local.get("theme");
  applyTheme(theme ?? "dark");
}

function applyTheme(theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  $("themeIcon").setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
}

$("themeToggle").addEventListener("click", async () => {
  const theme = document.documentElement.classList.contains("dark") ? "light" : "dark";
  applyTheme(theme);
  await chrome.storage.local.set({ theme });
});

/* ---------- tabs ---------- */

const TABS = ["settings", "logs"];

function switchTab(name) {
  for (const id of TABS) {
    $(`nav-${id}`).setAttribute("aria-selected", String(id === name));
    $(`tab-${id}`).hidden = id !== name;
  }
  if (name === "logs") void renderLog();
}

for (const id of TABS) $(`nav-${id}`).addEventListener("click", () => switchTab(id));

/* ---------- token ---------- */

/**
 * Stored in `local`, not `sync`: this token only authorises the app on this
 * one machine, so pushing it through the user's Google account would spread a
 * credential to profiles that have no app to pair with.
 */
async function loadToken() {
  const { token } = await chrome.storage.local.get("token");
  if (token) tokenInput.value = token;
}

$("save").addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus("Token masih kosong.", "bad");
    return;
  }
  await chrome.storage.local.set({ token });
  setStatus("Token disimpan.", "ok");
  showToast("Token pairing disimpan");
  void refreshConnection();
});

$("reveal").addEventListener("click", () => {
  const hidden = tokenInput.type === "password";
  tokenInput.type = hidden ? "text" : "password";
  $("revealIcon").setAttribute("href", hidden ? "#i-eye-off" : "#i-eye");
});

/**
 * Hits `/ping` so the user can tell the three failure modes apart: app not
 * running, app running with the bridge off, and app reachable but the token
 * wrong. Saving a token that silently doesn't work is the worse outcome.
 */
async function ping(token) {
  if (!token) return { kind: "no-token" };
  let response;
  try {
    response = await fetch(`${BRIDGE_ORIGIN}/ping`, { headers: { [TOKEN_HEADER]: token } });
  } catch {
    return { kind: "unreachable" };
  }
  if (response.status === 401) return { kind: "bad-token" };
  if (!response.ok) return { kind: "http", status: response.status };
  const info = await response.json().catch(() => null);
  return { kind: "ok", version: info?.version };
}

$("test").addEventListener("click", async () => {
  setStatus("Menghubungi aplikasi…");
  const result = await refreshConnection();
  switch (result.kind) {
    case "ok":
      setStatus(`Tersambung ke Download Engine ${result.version ?? ""}.`.trim(), "ok");
      showToast("Bridge merespons, token diterima");
      break;
    case "no-token":
      setStatus("Isi token dulu.", "bad");
      break;
    case "bad-token":
      setStatus("Aplikasi terhubung, tapi token ditolak. Copy ulang dari Settings.", "bad");
      showToast("Token ditolak aplikasi", false);
      break;
    case "unreachable":
      setStatus('Tidak ada jawaban. Pastikan aplikasi jalan dan "Terima Link dari Extension Browser" aktif di Settings.', "bad");
      showToast("Aplikasi tidak merespons", false);
      break;
    default:
      setStatus(`Aplikasi menjawab HTTP ${result.status}.`, "bad");
      showToast(`Aplikasi menjawab HTTP ${result.status}`, false);
  }
});

/**
 * Drives both the header badge and the card's tag from one probe, so the two
 * can never disagree about whether the bridge is up.
 */
async function refreshConnection() {
  const { token } = await chrome.storage.local.get("token");
  const result = await ping(token);

  const views = {
    ok: ["is-ok", "Bridge Connected (127.0.0.1:47283)", "is-ok", "Authenticated"],
    "bad-token": ["is-bad", "Token ditolak bridge", "", "Token salah"],
    "no-token": ["", "Token belum diisi", "", "Belum di-pairing"],
    unreachable: ["is-bad", "Bridge tidak merespons", "", "Tidak tersambung"],
  };
  const [badgeClass, badgeText, tagClass, tagText] = views[result.kind] ?? ["is-bad", `Bridge menjawab HTTP ${result.status}`, "", `HTTP ${result.status}`];

  connBadge.className = `status-badge ${badgeClass}`;
  connText.textContent = badgeText;
  authTag.className = `tag ${tagClass}`;
  authTag.textContent = tagText;
  return result;
}

/* ---------- permissions ---------- */

/**
 * Both checkboxes reflect the permission Chrome actually holds, not a saved
 * preference — the user can revoke from Chrome's own extension page at any
 * time, and a tick that survived that would be lying about what happens next.
 */
async function refreshCookieState() {
  const granted = await chrome.permissions.contains({ permissions: ["cookies"], origins: ["<all_urls>"] });
  cookiesCheckbox.checked = granted;
  cookieState.className = granted ? "value is-ok" : "value";
  cookieState.innerHTML = granted ? `${icon("check")} Izin cookie aktif` : `${icon("x")} Cookie tidak disertakan`;
}

async function refreshInterceptState() {
  const granted = await chrome.permissions.contains({ permissions: ["downloads"] });
  interceptCheckbox.checked = granted;
  interceptState.className = granted ? "value is-ok" : "value is-warn";
  interceptState.innerHTML = granted ? `${icon("check")} Download browser diambil alih` : `${icon("pause")} Download browser tidak disentuh`;
}

/**
 * The permission prompt needs the user gesture this event carries, which is why
 * the request lives here and not where the permission is used.
 *
 * `request` throws — rather than returning false — when Chrome's copy of the
 * manifest doesn't list the permission as optional. For an unpacked extension
 * that means the files on disk changed but it was never reloaded: Chrome
 * re-reads HTML and JS every time, so a new toggle can appear while the new
 * manifest has not been picked up. Refreshing in `finally` keeps the tick
 * honest whichever way it went.
 */
function bindPermissionToggle(checkbox, request, refresh) {
  checkbox.addEventListener("change", async () => {
    try {
      if (checkbox.checked) {
        const granted = await chrome.permissions.request(request);
        if (!granted) showToast("Izin ditolak", false);
      } else {
        await chrome.permissions.remove(request);
      }
    } catch (e) {
      setStatus(`Chrome menolak permintaan izin: ${e.message}. Reload extension di chrome://extensions, lalu coba lagi.`, "bad");
      showToast("Reload extension dulu di chrome://extensions", false);
    } finally {
      await refresh();
    }
  });
}

bindPermissionToggle(cookiesCheckbox, { permissions: ["cookies"], origins: ["<all_urls>"] }, refreshCookieState);
bindPermissionToggle(interceptCheckbox, { permissions: ["downloads"] }, refreshInterceptState);

/* ---------- log ---------- */

const STATUS_VIEW = {
  sent: ["ok", "Terkirim ke Engine"],
  rejected: ["bad", "Ditolak aplikasi"],
  unreachable: ["bad", "Aplikasi tidak merespons"],
};

const SOURCE_VIEW = {
  intercept: "Intersepsi",
  menu: "Klik-kanan",
  popup: "Popup",
};

async function renderLog() {
  const { log = [] } = await chrome.storage.local.get("log");

  if (log.length === 0) {
    logBody.innerHTML = '<tr><td colspan="5" class="empty">Belum ada URL yang diserahkan ke aplikasi.</td></tr>';
    return;
  }

  logBody.replaceChildren(
    ...log.map((entry) => {
      const [statusClass, statusText] = STATUS_VIEW[entry.status] ?? ["none", entry.status];
      const row = document.createElement("tr");
      // Built as nodes, not an HTML string: the URL comes from a page the user
      // visited, and interpolating it into markup would let a crafted link
      // inject into this page.
      const cells = [
        ["time", new Date(entry.at).toLocaleTimeString("id-ID")],
        ["url", entry.url],
        ["none", SOURCE_VIEW[entry.source] ?? entry.source],
        [entry.cookie ? "ok" : "none", entry.cookie ? "Ada" : "Tidak"],
        [statusClass, statusText],
      ];
      for (const [className, text] of cells) {
        const cell = document.createElement("td");
        cell.className = className;
        cell.textContent = text;
        row.append(cell);
      }
      return row;
    })
  );
}

$("clearLogs").addEventListener("click", async () => {
  await chrome.storage.local.remove("log");
  await renderLog();
  showToast("Log intersepsi dibersihkan");
});

// Keeps an open options page current while downloads are being handed over.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.log && !$("tab-logs").hidden) void renderLog();
});

/* ---------- boot ---------- */

async function init() {
  $("versionPill").textContent = `Chrome Extension v${chrome.runtime.getManifest().version}`;
  await loadTheme();
  await loadToken();
  await Promise.all([refreshCookieState(), refreshInterceptState(), refreshConnection(), renderLog()]);
}

void init();
