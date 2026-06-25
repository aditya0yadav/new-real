// popup.js — Market Research Tracker Extension Popup

const dot          = document.getElementById('dot');
const statusLabel  = document.getElementById('statusLabel');
const sessionDets  = document.getElementById('sessionDetails');
const noSessionMsg = document.getElementById('noSessionMsg');
const statsGrid    = document.getElementById('statsGrid');
const durationEl   = document.getElementById('durationEl');
const sessionIdEl  = document.getElementById('sessionIdEl');
const surveyIdEl   = document.getElementById('surveyIdEl');
const statPages    = document.getElementById('statPages');
const statLogs     = document.getElementById('statLogs');
const statEvents   = document.getElementById('statEvents');

let durationTimer = null;
const BACKEND = 'http://localhost:4000';

async function render() {
  try {
    // Get session from extension storage
    const data = await chrome.storage.local.get('activeSession');
    const session = data.activeSession;

    if (session) {
      showRecording(session);
    } else {
      showIdle();
    }
  } catch (e) {
    showIdle();
  }
}

function showRecording(session) {
  // Dot + label
  dot.className = 'status-dot active';
  statusLabel.className = 'status-label active';
  statusLabel.textContent = '● Recording Active';

  // Session details
  sessionDets.style.display = 'flex';
  noSessionMsg.style.display = 'none';
  statsGrid.style.display = 'grid';

  sessionIdEl.textContent = session.sessionId.substring(0, 18) + '…';
  surveyIdEl.textContent  = session.surveyId || '—';

  // Duration counter
  clearInterval(durationTimer);
  function tick() {
    const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    durationEl.textContent = `${m}:${s}`;
  }
  tick();
  durationTimer = setInterval(tick, 1000);

  // Fetch live stats from backend
  fetchStats(session.sessionId);
}

function showIdle() {
  clearInterval(durationTimer);
  dot.className = 'status-dot idle';
  statusLabel.className = 'status-label idle';
  statusLabel.textContent = 'No Active Session';
  sessionDets.style.display = 'none';
  statsGrid.style.display = 'none';
  noSessionMsg.style.display = 'block';
}

async function fetchStats(sessionId) {
  try {
    const res = await fetch(`${BACKEND}/api/session/${sessionId}`);
    if (!res.ok) return;
    const { session } = await res.json();
    if (session) {
      statPages.textContent  = session.pageCount   || 0;
      statLogs.textContent   = session.logCount    || 0;
      statEvents.textContent = session.eventCount  || 0;
    }
  } catch (_) {}
}

// Initial render + refresh every 3s
render();
setInterval(render, 3000);
