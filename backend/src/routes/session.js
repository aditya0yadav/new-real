const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const SESSIONS_DIR = path.join(__dirname, '../../sessions');

// ─── Multer setup for video chunk uploads ─────────────────────
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const videoDir = path.join(SESSIONS_DIR, req.params.id, 'video');
    ensureDir(videoDir);
    cb(null, videoDir);
  },
  filename: (req, file, cb) => {
    const session = readJSON(path.join(SESSIONS_DIR, req.params.id, 'session.json'));
    const chunkIndex = session ? session.videoChunks || 0 : 0;
    cb(null, `chunk_${String(chunkIndex).padStart(4, '0')}.webm`);
  }
});
const upload = multer({ storage: chunkStorage });

// ─── Helpers ─────────────────────────────────────────────────
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function appendToJSONArray(filePath, item) {
  let arr = [];
  if (fs.existsSync(filePath)) {
    try { arr = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { arr = []; }
  }
  arr.push(item);
  fs.writeFileSync(filePath, JSON.stringify(arr, null, 2), 'utf8');
}

function getSessionDir(sessionId) {
  return path.join(SESSIONS_DIR, sessionId);
}

function updateSessionMeta(sessionId, updates) {
  const sessionFile = path.join(getSessionDir(sessionId), 'session.json');
  const session = readJSON(sessionFile);
  if (session) {
    Object.assign(session, updates);
    writeJSON(sessionFile, session);
    return session;
  }
  return null;
}

// ─── Routes ──────────────────────────────────────────────────

// GET /api/session — list all sessions
router.get('/', (req, res) => {
  ensureDir(SESSIONS_DIR);
  try {
    const dirs = fs.readdirSync(SESSIONS_DIR).filter(f =>
      fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory()
    );
    const sessions = dirs
      .map(dir => readJSON(path.join(SESSIONS_DIR, dir, 'session.json')))
      .filter(Boolean)
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    res.json({ sessions, total: sessions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session/create
router.post('/create', (req, res) => {
  const { surveyId, surveyUrl } = req.body;
  if (!surveyId || !surveyUrl) {
    return res.status(400).json({ error: 'surveyId and surveyUrl are required' });
  }

  const sessionId = uuidv4();
  const sessionDir = getSessionDir(sessionId);

  ensureDir(sessionDir);
  ensureDir(path.join(sessionDir, 'snapshots'));
  ensureDir(path.join(sessionDir, 'video'));

  const session = {
    sessionId,
    surveyId,
    surveyUrl,
    status: 'recording',
    startTime: new Date().toISOString(),
    endTime: null,
    duration: null,
    pageCount: 0,
    logCount: 0,
    eventCount: 0,
    videoChunks: 0,
    videoSizeBytes: 0,
    snapshotCount: 0,
  };

  writeJSON(path.join(sessionDir, 'session.json'), session);
  writeJSON(path.join(sessionDir, 'pages.json'), []);
  writeJSON(path.join(sessionDir, 'logs.json'), []);
  writeJSON(path.join(sessionDir, 'events.json'), []);

  console.log(`✅ Session created: ${sessionId} | Survey: ${surveyId}`);
  res.json({ sessionId, status: 'created', session });
});

// GET /api/session/:id
router.get('/:id', (req, res) => {
  const sessionDir = getSessionDir(req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  const session  = readJSON(path.join(sessionDir, 'session.json'));
  const pages    = readJSON(path.join(sessionDir, 'pages.json')) || [];
  const logs     = readJSON(path.join(sessionDir, 'logs.json')) || [];
  const events   = readJSON(path.join(sessionDir, 'events.json')) || [];

  res.json({ session, pages, logs, events });
});

// POST /api/session/:id/page — page visit info
router.post('/:id/page', (req, res) => {
  const sessionDir = getSessionDir(req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  const entry = { ...req.body, receivedAt: new Date().toISOString() };
  appendToJSONArray(path.join(sessionDir, 'pages.json'), entry);

  const session = readJSON(path.join(sessionDir, 'session.json'));
  if (session) {
    session.pageCount = (session.pageCount || 0) + 1;
    session.lastPageUrl = req.body.url;
    writeJSON(path.join(sessionDir, 'session.json'), session);
  }

  console.log(`📄 Page: ${req.params.id.substring(0, 8)}... | ${req.body.url}`);
  res.json({ ok: true });
});

// POST /api/session/:id/html — full HTML snapshot
router.post('/:id/html', (req, res) => {
  const sessionDir = getSessionDir(req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  const { url, html, timestamp, domain, timing, title } = req.body;
  if (!html) return res.status(400).json({ error: 'html is required' });

  // Save HTML file named by timestamp + domain
  const safeFilename = `${timestamp}_${(domain || 'page').replace(/[^a-z0-9]/gi, '_').substring(0, 50)}.html`;
  const snapshotPath = path.join(sessionDir, 'snapshots', safeFilename);
  fs.writeFileSync(snapshotPath, html, 'utf8');

  // Log snapshot metadata
  appendToJSONArray(path.join(sessionDir, 'pages.json'), {
    type: 'html_snapshot',
    url, domain, title, timestamp, timing,
    snapshotFile: safeFilename,
    htmlSizeKB: Math.round(html.length / 1024),
    receivedAt: new Date().toISOString(),
  });

  const session = readJSON(path.join(sessionDir, 'session.json'));
  if (session) {
    session.snapshotCount = (session.snapshotCount || 0) + 1;
    writeJSON(path.join(sessionDir, 'session.json'), session);
  }

  console.log(`📸 HTML snapshot: ${req.params.id.substring(0, 8)}... | ${url} (${Math.round(html.length / 1024)}KB)`);
  res.json({ ok: true, filename: safeFilename });
});

// POST /api/session/:id/log — console log / JS error
router.post('/:id/log', (req, res) => {
  const sessionDir = getSessionDir(req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  const entry = { ...req.body, receivedAt: new Date().toISOString() };
  appendToJSONArray(path.join(sessionDir, 'logs.json'), entry);

  const session = readJSON(path.join(sessionDir, 'session.json'));
  if (session) {
    session.logCount = (session.logCount || 0) + 1;
    writeJSON(path.join(sessionDir, 'session.json'), session);
  }

  res.json({ ok: true });
});

// POST /api/session/:id/event — user interaction event
router.post('/:id/event', (req, res) => {
  const sessionDir = getSessionDir(req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  const entry = { ...req.body, receivedAt: new Date().toISOString() };
  appendToJSONArray(path.join(sessionDir, 'events.json'), entry);

  const session = readJSON(path.join(sessionDir, 'session.json'));
  if (session) {
    session.eventCount = (session.eventCount || 0) + 1;
    writeJSON(path.join(sessionDir, 'session.json'), session);
  }

  res.json({ ok: true });
});

// POST /api/session/:id/chunk — video chunk (multipart/form-data)
router.post('/:id/chunk', upload.single('video'), (req, res) => {
  const sessionDir = getSessionDir(req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  if (!req.file) return res.status(400).json({ error: 'No video chunk provided' });

  const session = readJSON(path.join(sessionDir, 'session.json'));
  const chunkIndex = session ? (session.videoChunks || 0) : 0;

  // Rename to proper sequential filename
  const destPath = path.join(sessionDir, 'video', `chunk_${String(chunkIndex).padStart(4, '0')}.webm`);
  if (req.file.path !== destPath) {
    fs.renameSync(req.file.path, destPath);
  }

  if (session) {
    session.videoChunks = chunkIndex + 1;
    session.videoSizeBytes = (session.videoSizeBytes || 0) + req.file.size;
    writeJSON(path.join(sessionDir, 'session.json'), session);
  }

  console.log(`🎬 Video chunk #${chunkIndex}: ${req.params.id.substring(0, 8)}... (${Math.round(req.file.size / 1024)}KB)`);
  res.json({ ok: true, chunkIndex, sizeKB: Math.round(req.file.size / 1024) });
});

// POST /api/session/:id/end — finalize session
router.post('/:id/end', (req, res) => {
  const sessionDir = getSessionDir(req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  const sessionFile = path.join(sessionDir, 'session.json');
  const session = readJSON(sessionFile);

  if (session) {
    const endTime = new Date().toISOString();
    const durationMs = new Date(endTime) - new Date(session.startTime);
    session.status = 'completed';
    session.endTime = endTime;
    session.duration = Math.floor(durationMs / 1000);
    writeJSON(sessionFile, session);

    console.log(`\n🏁 Session completed: ${req.params.id}`);
    console.log(`   Duration  : ${session.duration}s`);
    console.log(`   Pages     : ${session.pageCount}`);
    console.log(`   Logs      : ${session.logCount}`);
    console.log(`   Events    : ${session.eventCount}`);
    console.log(`   Snapshots : ${session.snapshotCount}`);
    console.log(`   Video     : ${session.videoChunks} chunks (${Math.round((session.videoSizeBytes || 0) / 1024)}KB)\n`);

    res.json({ ok: true, session });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// DELETE /api/session/:id
router.delete('/:id', (req, res) => {
  const sessionDir = getSessionDir(req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  fs.rmSync(sessionDir, { recursive: true, force: true });
  console.log(`🗑️  Session deleted: ${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
