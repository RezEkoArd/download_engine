const BRIDGE_ORIGIN = "http://127.0.0.1:47283";
const TOKEN_HEADER = "x-download-engine-token";

const tokenInput = document.getElementById("token");
const statusEl = document.getElementById("status");
const permStatusEl = document.getElementById("permStatus");
const cookiesCheckbox = document.getElementById("cookies");

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = kind;
}

/**
 * Stored in `local`, not `sync`: this token only authorises the app on this
 * one machine, so pushing it through the user's Google account would spread a
 * credential to profiles that have no app to pair with.
 */
async function load() {
  const { token } = await chrome.storage.local.get("token");
  if (token) tokenInput.value = token;
  await refreshPermissionState();
}

document.getElementById("save").addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus("Token masih kosong.", "bad");
    return;
  }
  await chrome.storage.local.set({ token });
  setStatus("Token disimpan.", "ok");
});

document.getElementById("reveal").addEventListener("click", () => {
  tokenInput.type = tokenInput.type === "password" ? "text" : "password";
});

/**
 * Hits `/ping` so the user can tell the three failure modes apart: app not
 * running, app running with the bridge off, and app reachable but the token
 * wrong. Saving a token that silently doesn't work is the worse outcome.
 */
document.getElementById("test").addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus("Isi token dulu.", "bad");
    return;
  }

  setStatus("Menghubungi aplikasi…");
  let response;
  try {
    response = await fetch(`${BRIDGE_ORIGIN}/ping`, { headers: { [TOKEN_HEADER]: token } });
  } catch {
    setStatus("Tidak ada jawaban. Pastikan aplikasi jalan dan \"Terima Link dari Extension Browser\" aktif di Settings.", "bad");
    return;
  }

  if (response.status === 401) {
    setStatus("Aplikasi terhubung, tapi token ditolak. Copy ulang dari Settings.", "bad");
    return;
  }
  if (!response.ok) {
    setStatus(`Aplikasi menjawab HTTP ${response.status}.`, "bad");
    return;
  }

  const info = await response.json().catch(() => null);
  setStatus(`Tersambung ke Download Engine ${info?.version ?? ""}.`.trim(), "ok");
});

/**
 * The checkbox reflects the real permission, not a saved preference — the user
 * can revoke it from Chrome's own extension page at any time, and a checkbox
 * that still looked ticked after that would be lying.
 */
async function refreshPermissionState() {
  const granted = await chrome.permissions.contains({
    permissions: ["cookies"],
    origins: ["<all_urls>"],
  });
  cookiesCheckbox.checked = granted;
  permStatusEl.textContent = granted ? "Izin cookie aktif." : "Izin cookie belum diberikan.";
}

cookiesCheckbox.addEventListener("change", async () => {
  // The prompt needs the user gesture this event carries, which is why the
  // request lives here and not in the context-menu handler.
  const request = { permissions: ["cookies"], origins: ["<all_urls>"] };
  if (cookiesCheckbox.checked) {
    const granted = await chrome.permissions.request(request);
    if (!granted) setStatus("Izin cookie ditolak.", "bad");
  } else {
    await chrome.permissions.remove(request);
  }
  await refreshPermissionState();
});

void load();
