import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';
import { EXTENSION_ID, BACKEND_URL } from './config';

// ── App States ────────────────────────────────────────────────
// detecting → ready | no_extension → selecting_screen → recording → completed | error

export default function App() {
  const [extState, setExtState]         = useState('detecting'); // detecting | ready | no_extension
  const [extVersion, setExtVersion]     = useState(null);
  const [recordState, setRecordState]   = useState('idle');      // idle | selecting | recording | stopping | done
  const [sessionId, setSessionId]       = useState(null);
  const [statusMsg, setStatusMsg]       = useState('');
  const [error, setError]               = useState(null);
  const [elapsed, setElapsed]           = useState(0);
  const [stats, setStats]               = useState({ pages: 0, logs: 0, events: 0, chunks: 0 });

  const mediaRecorderRef = useRef(null);
  const streamRef        = useRef(null);
  const timerRef         = useRef(null);
  const statsIntervalRef = useRef(null);
  const startTimeRef     = useRef(null);
  const chunkIndexRef    = useRef(0);

  // Read URL params
  const params    = new URLSearchParams(window.location.search);
  const surveyId  = params.get('surveyId')  || 'demo-survey-001';
  const surveyUrl = params.get('surveyUrl') || 'https://example.com/survey';

  // ── 1. Detect extension on mount ─────────────────────────
  useEffect(() => {
    pingExtension();
  }, []);

  async function pingExtension() {
    setExtState('detecting');
    setStatusMsg('Looking for Market Research Tracker extension…');

    if (!window.chrome?.runtime?.sendMessage) {
      setExtState('no_extension');
      setStatusMsg('Chrome extension API not available. Make sure you are using Chrome or AdsPower.');
      return;
    }

    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          EXTENSION_ID,
          { type: 'PING' },
          (res) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(res);
          }
        );
      });

      if (response?.status === 'EXTENSION_READY') {
        setExtState('ready');
        setExtVersion(response.version);

        // If extension already has an active session, restore it
        if (response.hasActiveSession && response.activeSession) {
          const s = response.activeSession;
          setSessionId(s.sessionId);
          setStatusMsg('Existing session detected.');
        } else {
          setStatusMsg('Extension detected. Ready to start recording.');
        }
      }
    } catch (e) {
      setExtState('no_extension');
      setStatusMsg('Extension not found. Please install Market Research Tracker from the company portal.');
    }
  }

  // ── 2. Start Recording ────────────────────────────────────
  const startRecording = useCallback(async () => {
    if (extState !== 'ready') return;
    setError(null);
    setRecordState('selecting');
    setStatusMsg('📺 Select your screen in the dialog that appears…');

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          mediaSource: 'screen',
          width:     { ideal: 1920 },
          height:    { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
    } catch (e) {
      setRecordState('idle');
      setStatusMsg('Screen selection cancelled or permission denied.');
      setError(e.message);
      return;
    }

    streamRef.current = stream;
    setRecordState('starting');
    setStatusMsg('⚙️ Creating session on server…');

    // Create session on backend
    let sid;
    try {
      const res = await fetch(`${BACKEND_URL}/api/session/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surveyId, surveyUrl }),
      });
      const data = await res.json();
      sid = data.sessionId;
      setSessionId(sid);
    } catch (e) {
      setRecordState('idle');
      setStatusMsg('Could not connect to backend. Is the server running?');
      setError(e.message);
      stream.getTracks().forEach(t => t.stop());
      return;
    }

    // Notify extension — it will start collecting page data with this sessionId
    try {
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          EXTENSION_ID,
          { type: 'START_SESSION', sessionId: sid, surveyId, surveyUrl },
          (res) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(res);
          }
        );
      });
    } catch (e) {
      console.warn('Could not notify extension:', e);
      // Continue anyway — recording still works without extension data collection
    }

    // Start MediaRecorder
    chunkIndexRef.current = 0;
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';

    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        const idx = chunkIndexRef.current++;
        const formData = new FormData();
        formData.append('video', e.data, `chunk_${idx}.webm`);
        try {
          await fetch(`${BACKEND_URL}/api/session/${sid}/chunk`, {
            method: 'POST',
            body: formData,
          });
        } catch (err) {
          console.warn('Chunk upload failed:', err);
        }
      }
    };

    recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
    };

    // If user closes screen share tab, auto-stop
    stream.getTracks()[0].addEventListener('ended', () => {
      if (mediaRecorderRef.current?.state !== 'inactive') {
        stopRecording();
      }
    });

    recorder.start(5000); // chunk every 5s
    startTimeRef.current = Date.now();
    setRecordState('recording');
    setStatusMsg('🔴 Recording in progress. Switch to your survey tab and work normally.');

    // Start elapsed timer
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);

    // Poll live stats every 5s
    statsIntervalRef.current = setInterval(() => fetchStats(sid), 5000);
  }, [extState, surveyId, surveyUrl]);

  // ── 3. Stop Recording ─────────────────────────────────────
  const stopRecording = useCallback(async () => {
    if (recordState !== 'recording') return;
    setRecordState('stopping');
    setStatusMsg('⏳ Finalizing session…');

    clearInterval(timerRef.current);
    clearInterval(statsIntervalRef.current);

    // Stop MediaRecorder (triggers final ondataavailable)
    if (mediaRecorderRef.current?.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    // Give final chunk a moment to upload
    await new Promise(r => setTimeout(r, 1500));

    // Notify extension to stop collecting
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(EXTENSION_ID, { type: 'STOP_SESSION' }, resolve);
      });
    } catch (_) {}

    // Finalize session on backend
    try {
      await fetch(`${BACKEND_URL}/api/session/${sessionId}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      console.warn('Could not end session on backend:', e);
    }

    // Final stats
    await fetchStats(sessionId);
    setRecordState('done');
    setStatusMsg('✅ Session saved successfully. All data has been captured.');
  }, [recordState, sessionId]);

  // ── Fetch live stats ──────────────────────────────────────
  async function fetchStats(sid) {
    if (!sid) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/session/${sid}`);
      if (!res.ok) return;
      const { session } = await res.json();
      if (session) {
        setStats({
          pages:  session.pageCount  || 0,
          logs:   session.logCount   || 0,
          events: session.eventCount || 0,
          chunks: session.videoChunks || 0,
        });
      }
    } catch (_) {}
  }

  // ── Format timer ──────────────────────────────────────────
  const formatTime = (secs) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
  };

  const isRecording = recordState === 'recording';
  const canStart    = extState === 'ready' && (recordState === 'idle' || recordState === 'done');
  const canStop     = isRecording;

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="app-logo">
          <div className="logo-icon">🔬</div>
          <div>
            <div className="logo-text">Market Research Tracker</div>
            <div className="logo-sub">Session Recording Bridge</div>
          </div>
        </div>
        <div className="header-badge">Internal Tool</div>
      </header>

      <main className="main">

        {/* Extension Status */}
        <div className="card">
          <div className="card-title">Extension Status</div>
          <div className="ext-status">
            <div className={`ext-icon ${extState}`}>
              {extState === 'detecting'    && '🔍'}
              {extState === 'ready'        && '✅'}
              {extState === 'no_extension' && '❌'}
            </div>
            <div className="ext-info">
              <div className={`ext-label ${extState}`}>
                {extState === 'detecting'    && 'Detecting Extension…'}
                {extState === 'ready'        && 'Extension Detected'}
                {extState === 'no_extension' && 'Extension Not Found'}
              </div>
              <div className="ext-desc">
                {extState === 'ready'
                  ? 'Market Research Tracker is active and ready to capture data.'
                  : extState === 'no_extension'
                  ? 'Please install the extension and refresh this page.'
                  : 'Checking for browser extension…'}
              </div>
            </div>
            {extState === 'ready' && extVersion && (
              <div className="ext-version">v{extVersion}</div>
            )}
            {extState === 'detecting' && <div className="spinner" />}
          </div>
        </div>

        {/* Survey Info */}
        <div className="card">
          <div className="card-title">Survey Details</div>
          <div className="survey-grid">
            <div className="survey-field">
              <div className="field-label">Survey ID</div>
              <div className="field-value mono">{surveyId}</div>
            </div>
            <div className="survey-field">
              <div className="field-label">Status</div>
              <div className="field-value" style={{ color: isRecording ? '#ef4444' : '#94a3b8' }}>
                {isRecording ? '● Recording' : recordState === 'done' ? '✓ Completed' : '○ Standby'}
              </div>
            </div>
            <div className="survey-field" style={{ gridColumn: '1 / -1' }}>
              <div className="field-label">Survey URL</div>
              <div className="field-value url" onClick={() => window.open(surveyUrl, '_blank')}>
                {surveyUrl}
              </div>
            </div>
          </div>
        </div>

        {/* Session ID (when active) */}
        {sessionId && (
          <div className="session-banner">
            <span className="session-banner-label">Session ID</span>
            <span className="session-banner-id">{sessionId}</span>
          </div>
        )}

        {/* Recording Controls */}
        <div className="card controls-card">
          {/* Timer */}
          <div className={`timer ${isRecording ? '' : 'idle'}`}>
            {formatTime(elapsed)}
          </div>

          {/* Big Button */}
          <button
            className={`record-btn ${canStop ? 'stop' : canStart ? 'start' : 'disabled'}`}
            onClick={canStop ? stopRecording : canStart ? startRecording : undefined}
            disabled={!canStart && !canStop}
          >
            <div className="btn-icon">
              {recordState === 'idle'      && '▶'}
              {recordState === 'selecting' && '🖥️'}
              {recordState === 'starting'  && '⚙️'}
              {recordState === 'recording' && '⏹'}
              {recordState === 'stopping'  && '⏳'}
              {recordState === 'done'      && '✓'}
            </div>
            <div className="btn-label">
              {recordState === 'idle'      && 'Start Recording'}
              {recordState === 'selecting' && 'Select Screen'}
              {recordState === 'starting'  && 'Connecting…'}
              {recordState === 'recording' && 'Stop Recording'}
              {recordState === 'stopping'  && 'Saving…'}
              {recordState === 'done'      && 'Start New Session'}
            </div>
            {recordState === 'recording' && (
              <div className="btn-sub">Click to stop</div>
            )}
          </button>

          {/* Status message */}
          <div className="status-msg">
            {error
              ? <span className="error">{error}</span>
              : statusMsg}
          </div>

          {extState === 'no_extension' && (
            <button
              onClick={pingExtension}
              style={{
                background: 'transparent',
                border: '1px solid var(--indigo)',
                color: 'var(--indigo-light)',
                padding: '8px 20px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: '500',
              }}
            >
              🔄 Retry Detection
            </button>
          )}
        </div>

        {/* Stats Bar (shown after recording starts) */}
        {sessionId && (
          <div className="stats-bar">
            <div className={`stat-item ${isRecording ? 'active' : ''}`}>
              <div className="stat-num">{stats.pages}</div>
              <div className="stat-label">Pages</div>
            </div>
            <div className={`stat-item ${isRecording ? 'active' : ''}`}>
              <div className="stat-num">{stats.logs}</div>
              <div className="stat-label">Logs</div>
            </div>
            <div className={`stat-item ${isRecording ? 'active' : ''}`}>
              <div className="stat-num">{stats.events}</div>
              <div className="stat-label">Events</div>
            </div>
            <div className={`stat-item ${isRecording ? 'active' : ''}`}>
              <div className={`stat-num ${isRecording ? 'red' : ''}`}>{stats.chunks}</div>
              <div className="stat-label">Video Chunks</div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
