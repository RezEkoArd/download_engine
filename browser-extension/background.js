/**
 * Sends the right-clicked link to the Download Engine app over its loopback
 * bridge. See download_engine_gui/README.md for what guards that endpoint.
 */

const BRIDGE_ORIGIN = "http://127.0.0.1:47283";
const TOKEN_HEADER = "x-download-engine-token";
const MENU_ID = "send-to-download-engine";

/**
 * Menus created here survive the service worker being shut down and restarted,
 * so this runs on install and update rather than on every worker wake-up —
 * creating it twice throws.
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Download with Download Engine",
    contexts: ["link", "video", "audio", "image"],
  });
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  // `linkUrl` for a link, `srcUrl` for a media element. Right-clicking a
  // linked image gives both, and the link is the more likely intent.
  const url = info.linkUrl || info.srcUrl;
  if (url) void send(url, info.pageUrl);
});

/**
 * Request context the link may need to resolve.
 *
 * Nothing here is guessed: the referrer is the page the link was actually on,
 * and the User-Agent is this browser's own. Sending something invented would
 * only make a picky server behave differently than it does for the browser.
 */
async function buildHeaders(url, pageUrl) {
  const headers = { "user-agent": navigator.userAgent };

  // Only a real page is worth sending. A server that checks Referer wants the
  // page the link sat on; `chrome://` or `about:` would be noise at best.
  if (pageUrl && /^https?:\/\//.test(pageUrl)) {
    headers.referer = pageUrl;
  }

  const cookie = await cookieHeader(url);
  if (cookie) headers.cookie = cookie;

  return headers;
}

/**
 * The target site's cookies, or "" when cookie access hasn't been granted.
 *
 * Checked rather than requested: a permission prompt needs a user gesture and
 * cannot be raised from a context-menu handler. The options page is where the
 * user turns this on, which also means a link that needs a login simply fails
 * until they do — visibly, rather than by the extension quietly reaching for
 * more access than it was given.
 */
async function cookieHeader(url) {
  let origin;
  try {
    origin = `${new URL(url).origin}/*`;
  } catch {
    return "";
  }

  const granted = await chrome.permissions.contains({
    permissions: ["cookies"],
    origins: [origin],
  });
  if (!granted) return "";

  const cookies = await chrome.cookies.getAll({ url });
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function send(url, pageUrl) {
  const { token } = await chrome.storage.local.get("token");
  if (!token) {
    flash("!", "#dc2626", "Token belum diisi — buka opsi extension");
    chrome.runtime.openOptionsPage();
    return;
  }

  let response;
  try {
    response = await fetch(`${BRIDGE_ORIGIN}/download`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TOKEN_HEADER]: token,
      },
      body: JSON.stringify({ url, headers: await buildHeaders(url, pageUrl) }),
    });
  } catch {
    // A refused connection is the common case and has a specific cause worth
    // naming, rather than a generic "failed".
    flash("!", "#dc2626", "Aplikasi tidak merespons — jalankan Download Engine dan nyalakan bridge di Settings");
    return;
  }

  if (response.ok) {
    flash("✓", "#16a34a", "Dikirim ke Download Engine");
  } else if (response.status === 401) {
    flash("!", "#dc2626", "Token ditolak — cocokkan ulang lewat opsi extension");
  } else {
    flash("!", "#dc2626", `Ditolak aplikasi (HTTP ${response.status})`);
  }
}

/**
 * Feedback on the toolbar icon. Chosen over a system notification because that
 * would need a permission of its own for something this small.
 */
function flash(text, color, title) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title: `Download Engine — ${title}` });
  // Cleared on a timer the worker may not live to see; that's fine, since the
  // badge is advisory and the next click overwrites it anyway.
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: "Download Engine" });
  }, 4000);
}
