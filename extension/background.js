// =============================================================
//  Market Research Tracker — Background Service Worker
//  Manages: session state, extension ↔ bridge page messaging,
//           content script data relay to backend
// =============================================================

const BACKEND_URL = 'http://localhost:4000';

// Active session stored in memory + chrome.storage for persistence
let activeSession = null;

// ─── Restore state on startup ─────────────────────────────────
chrome.runtime.onStartup.addListener(async () => {
  const data = await chrome.storage.local.get('activeSession');
  if (data.activeSession) {
    activeSession = data.activeSession;
    setBadge('recording');
    console.log('[MRT] Restored active session:', activeSession.sessionId);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get('activeSession');
  if (data.activeSession) {
    activeSession = data.activeSession;
    setBadge('recording');
  }
});

// ─── Messages from Bridge Page (externally_connectable) ───────
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log('[MRT] External message:', message.type, 'from', sender.url);

  switch (message.type) {

    // Bridge page pings to check if extension is installed
    case 'PING':
      sendResponse({
        status: 'EXTENSION_READY',
        version: chrome.runtime.getManifest().version,
        hasActiveSession: !!activeSession,
        activeSession: activeSession
      });
      break;

    // Bridge page signals recording has started, pass sessionId
    case 'START_SESSION': {
      const { sessionId, surveyId, surveyUrl } = message;
      activeSession = {
        sessionId,
        surveyId,
        surveyUrl,
        startTime: Date.now()
      };
      chrome.storage.local.set({ activeSession });
      setBadge('recording');
      console.log('[MRT] Session started:', sessionId);
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
      sendResponse({
        hasActiveSession: !!activeSession,
        activeSession: activeSession
      });
      break;

    default:
      sendResponse({ error: 'Unknown message type' });
  }

  return true; // keep channel open for async responses
});

// ─── Messages from Content Scripts ────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!activeSession) {
    sendResponse({ ok: false, reason: 'no_active_session' });
    return true;
  }

  const { sessionId } = activeSession;

  switch (message.type) {
    case 'PAGE_VISIT':
      postToBackend(`/api/session/${sessionId}/page`, message.data);
      break;

    case 'PAGE_HTML':
      postToBackend(`/api/session/${sessionId}/html`, message.data);
      break;

    case 'CONSOLE_LOG':
      postToBackend(`/api/session/${sessionId}/log`, message.data);
      break;

    case 'PAGE_EVENT':
      postToBackend(`/api/session/${sessionId}/event`, message.data);
      break;

    default:
      break;
  }

  sendResponse({ ok: true });
  return true;
});

// ─── Helpers ──────────────────────────────────────────────────
async function postToBackend(path, data) {
  try {
    await fetch(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch (err) {
    console.warn('[MRT] Backend post failed:', path, err.message);
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
