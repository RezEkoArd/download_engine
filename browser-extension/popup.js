const BRIDGE_ORIGIN = "http://127.0.0.1:47283";
const TOKEN_HEADER = "x-download-engine-token";

const $ = (id) => document.getElementById(id);

function setStatus(message, kind = "") {
  $("status").textContent = message;
  $("status").className = kind;
}

/* ---------- theme ---------- */

// Shares the options page's stored choice so the two never look like different
// extensions.
chrome.storage.local.get("theme").then(({ theme }) => {
  document.documentElement.classList.toggle("dark", (theme ?? "dark") === "dark");
});

/* ---------- connection ---------- */

async function refreshConnection() {
  const { token } = await chrome.storage.local.get("token");
  const badge = $("connBadge");
  const text = $("connText");

  if (!token) {
    badge.className = "status-badge";
    text.textContent = "Token belum diisi";
    return;
  }

  try {
    const response = await fetch(`${BRIDGE_ORIGIN}/ping`, { headers: { [TOKEN_HEADER]: token } });
    if (response.ok) {
      badge.className = "status-badge is-ok";
      text.textContent = "Desktop App Online";
    } else {
      badge.className = "status-badge is-bad";
      text.textContent = response.status === 401 ? "Token ditolak" : `HTTP ${response.status}`;
    }
  } catch {
    badge.className = "status-badge is-bad";
    text.textContent = "Aplikasi tidak merespons";
  }
}

/* ---------- manual send ---------- */

$("send").addEventListener("click", async () => {
  const url = $("url").value.trim();
  if (!url) {
    setStatus("Tempel URL dulu.", "bad");
    return;
  }
  // Checked here so a typo fails with an explanation instead of becoming a job
  // in the app that can never resolve.
  if (!/^https?:\/\//i.test(url)) {
    setStatus("Hanya URL http(s) yang bisa diunduh engine.", "bad");
    return;
  }

  setStatus("Mengirim…");
  // Routed through the service worker rather than posted from here, so the one
  // copy of the send logic — header allowlist, cookie lookup, logging — covers
  // every entry point.
  const result = await chrome.runtime.sendMessage({ type: "send-url", url });

  if (result?.ok) {
    setStatus("Masuk antrian Download Engine.", "ok");
    $("url").value = "";
  } else if (result?.status === 401) {
    setStatus("Token ditolak — cocokkan ulang di Pengaturan.", "bad");
  } else if (result?.status) {
    setStatus(`Ditolak aplikasi (HTTP ${result.status}).`, "bad");
  } else {
    setStatus("Aplikasi tidak merespons. Jalankan Download Engine dan nyalakan bridge.", "bad");
  }
});

$("url").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("send").click();
});

/* ---------- permissions ---------- */

// Same rule as the options page: the switches show the permission Chrome holds,
// not a stored preference.
async function refreshToggles() {
  $("cookies").checked = await chrome.permissions.contains({ permissions: ["cookies"], origins: ["<all_urls>"] });
  $("intercept").checked = await chrome.permissions.contains({ permissions: ["downloads"] });
}

function bindPermissionToggle(checkbox, request) {
  checkbox.addEventListener("change", async () => {
    try {
      if (checkbox.checked) await chrome.permissions.request(request);
      else await chrome.permissions.remove(request);
    } catch (e) {
      setStatus(`Chrome menolak: ${e.message}`, "bad");
    } finally {
      await refreshToggles();
    }
  });
}

bindPermissionToggle($("cookies"), { permissions: ["cookies"], origins: ["<all_urls>"] });
bindPermissionToggle($("intercept"), { permissions: ["downloads"] });

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

void refreshConnection();
void refreshToggles();
