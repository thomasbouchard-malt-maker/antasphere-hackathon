// Service worker: takes the screenshot, talks to the guide server, and keeps
// per-tab task state so a guided task survives full page navigations.

const DEFAULT_SERVER = "http://localhost:8787";

async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  return serverUrl || DEFAULT_SERVER;
}

const stateKey = (tabId) => `tab:${tabId}`;

async function getState(tabId) {
  const key = stateKey(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] || { active: false, pending: false, sessionId: null, lastStep: null };
}

async function setState(tabId, patch) {
  const next = { ...(await getState(tabId)), ...patch };
  await chrome.storage.session.set({ [stateKey(tabId)]: next });
  return next;
}

async function guide(tab, payload) {
  const state = await getState(tab.id);
  await setState(tab.id, { pending: false });

  let screenshot;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
  } catch (e) {
    console.warn("Screenshot failed, continuing without it", e);
  }

  const res = await fetch(`${await getServerUrl()}/api/guide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, sessionId: state.sessionId, screenshot }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Server error ${res.status}`);

  await setState(tab.id, {
    sessionId: body.sessionId,
    lastStep: body,
    active: body.status !== "task_complete",
  });
  return body;
}

async function reset(tabId) {
  const { sessionId } = await getState(tabId);
  if (sessionId) {
    fetch(`${await getServerUrl()}/api/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  }
  await chrome.storage.session.remove(stateKey(tabId));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tab = sender.tab;
  const handlers = {
    guide: () => guide(tab, msg.payload),
    reset: () => reset(tab.id),
    getState: () => getState(tab.id),
    markPending: () => setState(tab.id, { pending: true }),
  };
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true; // async response
});

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {});
});
