/**
 * Sends links to the Download Engine app over its loopback bridge, either from
 * the right-click menu or by taking over a download the browser just started.
 * See download_engine_gui/README.md for what guards that endpoint.
 */

const BRIDGE_ORIGIN = "http://127.0.0.1:47283";
const TOKEN_HEADER = "x-download-engine-token";
const MENU_ID = "send-to-download-engine";

/**
 * Whether an intercepted download is confirmed before being handed over.
 *
 * On by default: taking over a download is visible to the user as their
 * browser's download silently disappearing, and a tool that does that without
 * asking is indistinguishable from one that is broken. The dialog is how the
 * hand-over announces itself; "Jangan tanya lagi" turns it off from there.
 */
const CONFIRM_DEFAULT = true;

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

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  // `linkUrl` for a link, `srcUrl` for a media element. Right-clicking a
  // linked image gives both, and the link is the more likely intent.
  const url = info.linkUrl || info.srcUrl;
  if (url) void send(url, info.pageUrl);
});

/**
 * Takes over a download the browser started on its own.
 *
 * The context menu only ever sees a link's `href`, which on many sites is not
 * what gets downloaded: an interstitial, a form submit or a redirect chain
 * resolves to a different URL, and until that has happened only the browser
 * knows the final one. `onCreated` hands it over once it does.
 *
 * Inactive unless the user grants `downloads` from the options page — that
 * permission reveals every download they make, which is far more than
 * installing a context menu should cost.
 */
async function onDownloadCreated(item) {
  // `finalUrl` is the end of the redirect chain, the URL bytes will actually
  // come from; `url` is only where the browser started.
  const url = item.finalUrl || item.url;

  // The engine speaks HTTP. `blob:`, `data:` and `filesystem:` URLs exist only
  // inside the browser's own memory, so handing one over would create a job
  // that can never resolve — after cancelling a download that would have worked.
  if (!/^https?:\/\//.test(url)) return;

  // Checked before the dialog, not after: asking about a download that could
  // never be handed over anyway would be a question with one real answer.
  const { token } = await chrome.storage.local.get("token");
  if (!token) return;

  const { confirmIntercept = CONFIRM_DEFAULT } = await chrome.storage.local.get("confirmIntercept");
  if (confirmIntercept) {
    await askFirst(item);
    return;
  }

  await handOver(item);
}

/**
 * Stops the browser's copy and asks before anything is handed over.
 *
 * The pause is what makes the question worth asking: without it the browser
 * would keep writing bytes while the dialog waited, so "Biarkan Browser" would
 * cost nothing but "Unduh dengan Engine" would already have downloaded part of
 * the file twice.
 */
async function askFirst(item) {
  try {
    await chrome.downloads.pause(item.id);
  } catch {
    // Small files can finish between `onCreated` and this call, and a finished
    // download cannot be un-finished. Leaving it alone is the only answer that
    // doesn't destroy a file the user already has.
    await record({ url: item.finalUrl || item.url, source: "intercept", cookie: false, status: "too-fast" });
    return;
  }

  // Queued rather than shown straight away. Only one action popup can be open
  // at a time, so two downloads started together would see the second one
  // replace the first — leaving the first paused with nothing left to answer
  // it. They are asked one after the other instead.
  const { queue = [] } = await chrome.storage.session.get("queue");
  if (!queue.includes(item.id)) {
    queue.push(item.id);
    await chrome.storage.session.set({ queue });
  }

  await showNext();
}

/**
 * Opens the question for the next paused download, under the toolbar icon.
 *
 * `chrome.action.openPopup` rather than a window of its own: a popup window
 * comes with an OS title bar and its own minimise and maximise buttons, which
 * made the dialog look like a second application rather than part of the
 * extension.
 */
async function showNext() {
  const { asking = null } = await chrome.storage.session.get("asking");
  if (asking !== null) return; // one at a time

  const { queue = [] } = await chrome.storage.session.get("queue");
  const next = queue.shift();

  if (next === undefined) {
    await chrome.storage.session.set({ queue: [] });
    await restorePopup();
    return;
  }

  await chrome.storage.session.set({ queue, asking: next });

  try {
    await chrome.action.setPopup({ popup: `confirm.html?id=${next}` });
    await chrome.action.openPopup();
  } catch {
    // Chrome refuses when no window is focused, and `openPopup` only exists
    // from Chrome 127. Either way the question cannot be put, and a download
    // left paused with nothing on screen to explain it would look like the
    // extension broke — so the browser gets it back.
    flash("!", "#f59e0b", "Tidak bisa menampilkan konfirmasi — diunduh browser");
    await chrome.storage.session.set({ asking: null });
    await resumeBrowser(next);
    await showNext();
  }
}

/** Puts the toolbar button back to its normal popup. */
async function restorePopup() {
  try {
    await chrome.action.setPopup({ popup: "popup.html" });
  } catch {
    // Nothing to restore to if the extension is being torn down.
  }
}

/**
 * Hands the download to the app, and only then stops the browser's copy.
 */
async function handOver(item) {
  const url = item.finalUrl || item.url;

  const { token } = await chrome.storage.local.get("token");
  if (!token) return;

  const headers = { "user-agent": navigator.userAgent };
  // The download item carries the referrer the browser itself used, which is
  // more reliable than the active tab: by now the user may have navigated away.
  if (item.referrer && /^https?:\/\//.test(item.referrer)) headers.referer = item.referrer;
  const cookie = await cookieHeader(url);
  if (cookie) headers.cookie = cookie;

  let response;
  try {
    response = await fetch(`${BRIDGE_ORIGIN}/download`, {
      method: "POST",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
      body: JSON.stringify({ url, headers }),
    });
  } catch {
    // The app isn't listening, so leave the browser to finish the job. This is
    // the whole reason the hand-over happens before the cancel: the other order
    // would make every download started while the app is closed vanish.
    await record({ url, source: "intercept", cookie: Boolean(cookie), status: "unreachable" });
    await resumeBrowser(item.id);
    return;
  }

  if (!response.ok) {
    flash("!", "#dc2626", `Ditolak aplikasi (HTTP ${response.status}) — tetap diunduh browser`);
    await record({ url, source: "intercept", cookie: Boolean(cookie), status: "rejected" });
    await resumeBrowser(item.id);
    return;
  }

  await record({ url, source: "intercept", cookie: Boolean(cookie), status: "sent" });

  // Only now, with the job accepted, is stopping the browser's copy safe.
  // Erasing the row too: a cancelled entry left behind reads as a download that
  // failed, rather than one deliberately moved elsewhere.
  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch {
    // Already finished, or erased by the user. The job is running either way;
    // the only cost is a duplicate the browser had time to write.
  }

  flash("✓", "#16a34a", "Diambil alih Download Engine");
}

/**
 * Lets the browser finish what it started.
 *
 * Every path that pauses a download has to reach this, including the ones that
 * fail: a download left paused with the dialog gone is a file the user asked
 * for that never arrives, and nothing on screen would say why.
 */
async function resumeBrowser(downloadId) {
  try {
    await chrome.downloads.resume(downloadId);
  } catch {
    // Not paused, already finished, or cancelled by the user from the browser's
    // own download list. All three mean there is nothing left to resume.
  }
}

/**
 * Stops treating a download as unanswered, and says whether it still was.
 *
 * Both the decision and the popup closing race to settle the same download —
 * the popup closes *because* a button was pressed — so whichever gets here
 * first wins and the other finds `false` and does nothing.
 *
 * In `session` rather than `local`: a paused download does not survive the
 * browser closing, so neither should the note about it.
 */
async function claim(downloadId) {
  const { asking = null } = await chrome.storage.session.get("asking");
  if (asking !== downloadId) return false;
  await chrome.storage.session.set({ asking: null });
  return true;
}

/**
 * The popup's answer.
 *
 * Runs after the message handler has already claimed the download and replied,
 * so the popup can close at once. Doing this work first would hold it open for
 * a network round trip.
 */
async function onDecision(downloadId, choice) {
  if (choice !== "engine") {
    await resumeBrowser(downloadId);
    await showNext();
    return;
  }

  // Re-read rather than trusting what `onCreated` saw: the filename, size and
  // final URL are often still being resolved when the dialog opens.
  let items = [];
  try {
    items = await chrome.downloads.search({ id: downloadId });
  } catch {
    // Permission revoked while the popup was open.
  }

  if (items.length) await handOver(items[0]);
  await showNext();
}

/**
 * A dismissed popup is an answer: the browser keeps the download.
 *
 * A popup that closes fires no event of its own, so the page holds a port open
 * for as long as it is on screen and this listener watches for that port
 * dropping. Clicking outside the popup is the ordinary way to dismiss one, so
 * this is not an edge case — it is the second most likely outcome.
 *
 * Registered at the top level because MV3 only wakes a stopped worker for
 * listeners attached in the first turn of the event loop.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith("confirm:")) return;
  const downloadId = Number(port.name.slice("confirm:".length));

  port.onDisconnect.addListener(async () => {
    // False when a button already settled it: the popup closes right after,
    // and resuming here would undo the hand-over that just happened.
    if (!(await claim(downloadId))) return;
    await resumeBrowser(downloadId);
    await showNext();
  });
});

/**
 * Attached synchronously, and deliberately not behind a permission check.
 *
 * MV3 only wakes a stopped service worker for events whose listeners were
 * registered in the first turn of its event loop. Deciding this after an
 * `await chrome.permissions.contains(...)` would appear to work and then stop
 * silently once the worker first idled out — the worst kind of failure here,
 * because the user would see downloads going to the browser again with nothing
 * to explain it.
 *
 * No check is needed anyway: `chrome.downloads` exists only while the
 * permission is held, so its presence *is* the check, and it is synchronous.
 */
if (chrome.downloads) chrome.downloads.onCreated.addListener(onDownloadCreated);

/**
 * Granting or revoking happens while this worker is awake — the options page
 * just talked to it — so the listener is attached or detached on the spot
 * rather than waiting for a restart. Cold starts are covered above.
 */
chrome.permissions.onAdded.addListener(() => {
  if (chrome.downloads && !chrome.downloads.onCreated.hasListener(onDownloadCreated)) {
    chrome.downloads.onCreated.addListener(onDownloadCreated);
  }
});

chrome.permissions.onRemoved.addListener(() => {
  if (chrome.downloads?.onCreated.hasListener(onDownloadCreated)) {
    chrome.downloads.onCreated.removeListener(onDownloadCreated);
  }
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

async function send(url, pageUrl, source = "menu") {
  const { token } = await chrome.storage.local.get("token");
  if (!token) {
    flash("!", "#dc2626", "Token belum diisi — buka opsi extension");
    chrome.runtime.openOptionsPage();
    return { ok: false };
  }

  const headers = await buildHeaders(url, pageUrl);

  let response;
  try {
    response = await fetch(`${BRIDGE_ORIGIN}/download`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TOKEN_HEADER]: token,
      },
      body: JSON.stringify({ url, headers }),
    });
  } catch {
    // A refused connection is the common case and has a specific cause worth
    // naming, rather than a generic "failed".
    flash("!", "#dc2626", "Aplikasi tidak merespons — jalankan Download Engine dan nyalakan bridge di Settings");
    await record({ url, source, cookie: Boolean(headers.cookie), status: "unreachable" });
    return { ok: false };
  }

  if (response.ok) {
    flash("✓", "#16a34a", "Dikirim ke Download Engine");
  } else if (response.status === 401) {
    flash("!", "#dc2626", "Token ditolak — cocokkan ulang lewat opsi extension");
  } else {
    flash("!", "#dc2626", `Ditolak aplikasi (HTTP ${response.status})`);
  }

  await record({ url, source, cookie: Boolean(headers.cookie), status: response.ok ? "sent" : "rejected" });
  return { ok: response.ok, status: response.status };
}

/**
 * Lets the popup reuse `send` instead of posting to the bridge itself, so the
 * header allowlist, cookie lookup and logging have exactly one implementation.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "send-url") {
    send(message.url, undefined, "popup").then(sendResponse);
    return true; // keeps the channel open for the async reply
  }

  if (message?.type === "intercept-decision") {
    // Claimed first so the popup's own closing cannot be mistaken for the user
    // walking away from the question; the hand-over then runs unwatched.
    claim(message.id).then((mine) => {
      sendResponse({ ok: mine });
      if (mine) void onDecision(message.id, message.choice);
    });
    return true;
  }

  return false;
});

/** How many hand-overs the log keeps. */
const LOG_LIMIT = 50;

/**
 * Records a hand-over so the options page can show what actually happened,
 * rather than the user having to guess whether a download reached the app.
 *
 * Capped and kept in `local`: these are URLs the user visited, so they stay on
 * this machine and never ride `sync` to another profile. "Bersihkan Log" on the
 * options page erases the lot.
 */
async function record(entry) {
  const { log = [] } = await chrome.storage.local.get("log");
  log.unshift({ at: Date.now(), ...entry });
  await chrome.storage.local.set({ log: log.slice(0, LOG_LIMIT) });
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
