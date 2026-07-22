// =============================================================
//  Market Research Tracker — Background Service Worker
//  Manages: session state, extension ↔ bridge page messaging,
//           content script data relay to backend
// =============================================================

const BACKEND_URL = 'https://server.realsays.com';

// Active session stored in memory + chrome.storage for persistence
let activeSession = null;

async function getActiveSession() {
  if (activeSession && activeSession.sessionId) return activeSession;
  try {
    const data = await chrome.storage.local.get('activeSession');
    if (data && data.activeSession && data.activeSession.sessionId) {
      activeSession = data.activeSession;
      return activeSession;
    }
  } catch (e) {
    console.warn('[MRT] Error reading activeSession from storage:', e);
  }
  return null;
}

// ─── Restore state on startup ─────────────────────────────────
chrome.runtime.onStartup.addListener(async () => {
  const session = await getActiveSession();
  if (session) {
    setBadge('recording');
    console.log('[MRT] Restored active session on startup:', session.sessionId);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const session = await getActiveSession();
  if (session) {
    setBadge('recording');
  }
});

// ─── Messages from Bridge Page (externally_connectable) ───────
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log('[MRT] External message:', message.type, 'from', sender.url);

  switch (message.type) {

    // Bridge page pings to check if extension is installed
    case 'PING':
      getActiveSession().then((session) => {
        sendResponse({
          status: 'EXTENSION_READY',
          version: chrome.runtime.getManifest().version,
          hasActiveSession: !!session,
          activeSession: session
        });
      });
      return true;

    // Bridge page signals recording has started, pass sessionId & backendUrl
    case 'START_SESSION': {
      const { sessionId, surveyId, surveyUrl, backendUrl } = message;
      activeSession = {
        sessionId,
        surveyId,
        surveyUrl,
        backendUrl: backendUrl || BACKEND_URL,
        startTime: Date.now()
      };
      chrome.storage.local.set({ activeSession });
      setBadge('recording');
      console.log('[MRT] Session started:', sessionId, 'Target Backend:', activeSession.backendUrl);

      // Notify all open tabs to re-send their page visit & re-hook console
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
            chrome.tabs.sendMessage(tab.id, { type: 'SESSION_STARTED', sessionId }).catch(() => {});
          }
        }
      });

      sendResponse({ success: true, sessionId });
      break;
    }

    // Bridge page signals recording has stopped
    case 'STOP_SESSION': {
      const stoppedId = activeSession?.sessionId || null;
      activeSession = null;
      chrome.storage.local.remove('activeSession');
      setBadge('idle');
      console.log('[MRT] Session stopped:', stoppedId);
      sendResponse({ success: true, sessionId: stoppedId });
      break;
    }

    // Bridge page queries current status
    case 'GET_STATUS':
      getActiveSession().then((session) => {
        sendResponse({
          hasActiveSession: !!session,
          activeSession: session
        });
      });
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }

  return true;
});

// ─── Messages from Content Scripts ────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SESSION_STARTED') {
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'START_SESSION') {
    const { sessionId, surveyId, surveyUrl, backendUrl } = message.data || message;
    activeSession = {
      sessionId,
      surveyId,
      surveyUrl,
      backendUrl: backendUrl || BACKEND_URL,
      startTime: Date.now()
    };
    chrome.storage.local.set({ activeSession });
    setBadge('recording');
    console.log('[MRT] Session started (via content script):', sessionId, 'Backend:', activeSession.backendUrl);
    sendResponse({ success: true, sessionId });
    return true;
  }

  if (message.type === 'STOP_SESSION') {
    const stoppedId = activeSession?.sessionId || null;
    activeSession = null;
    chrome.storage.local.remove('activeSession');
    setBadge('idle');
    console.log('[MRT] Session stopped (via content script):', stoppedId);
    sendResponse({ success: true, sessionId: stoppedId });
    return true;
  }

  (async () => {
    const session = await getActiveSession();
    if (!session || !session.sessionId) {
      sendResponse({ ok: false, reason: 'no_active_session' });
      return;
    }

    const { sessionId } = session;

    switch (message.type) {
      case 'PAGE_VISIT':
        await postToBackend(`/api/session/${sessionId}/page`, message.data);
        break;

      case 'PAGE_HTML':
        await postToBackend(`/api/session/${sessionId}/html`, message.data);
        break;

      case 'CONSOLE_LOG':
        await postToBackend(`/api/session/${sessionId}/log`, message.data);
        break;

      case 'PAGE_EVENT':
        await postToBackend(`/api/session/${sessionId}/event`, message.data);
        break;

      default:
        break;
    }

    sendResponse({ ok: true });
  })();

  return true; // Keep async message channel open
});

// ─── Helpers ──────────────────────────────────────────────────
async function postToBackend(path, data) {
  const session = await getActiveSession();
  const targetBackend = session?.backendUrl || BACKEND_URL;
  try {
    const res = await fetch(`${targetBackend}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      console.warn('[MRT] Backend post returned status:', res.status, path);
    } else {
      console.log('[MRT] Data posted successfully:', path);
    }
  } catch (err) {
    console.warn('[MRT] Backend post failed:', targetBackend + path, err.message);
  }
}

function setBadge(state) {
  if (state === 'recording') {
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}
