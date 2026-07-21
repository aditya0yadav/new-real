import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';
import { EXTENSION_ID, BACKEND_URL } from './config';

// ── App States ────────────────────────────────────────────────
// detecting → ready | no_extension → selecting_screen → recording → completed | error

export default function App() {
  const [activeTab, setActiveTab]       = useState('recorder'); // recorder | admin
  
  // ── Recorder States ──
  const [extState, setExtState]         = useState('detecting'); // detecting | ready | no_extension
  const [extVersion, setExtVersion]     = useState(null);
  const [recordState, setRecordState]   = useState('idle');      // idle | selecting | recording | stopping | done
  const [sessionId, setSessionId]       = useState(null);
  const [statusMsg, setStatusMsg]       = useState('');
  const [error, setError]               = useState(null);
  const [elapsed, setElapsed]           = useState(0);
  const [stats, setStats]               = useState({ pages: 0, logs: 0, events: 0, chunks: 0 });

  // ── Admin Dashboard States ──
  const [sessions, setSessions]         = useState([]);
  const [searchTerm, setSearchTerm]     = useState('');
  const [selectedSessId, setSelectedSessId] = useState(null);
  const [selectedSess, setSelectedSess] = useState(null);
  const [analysis, setAnalysis]         = useState(null);
  const [pipelineLogs, setPipelineLogs] = useState('');
  const [verifying, setVerifying]       = useState(false);
  const [rawView, setRawView]           = useState('none'); // none | session | events | pages | analysis

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

    // Notify extension
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

    stream.getTracks()[0].addEventListener('ended', () => {
      if (mediaRecorderRef.current?.state !== 'inactive') {
        stopRecording();
      }
    });

    recorder.start(5000);
    startTimeRef.current = Date.now();
    setRecordState('recording');
    setStatusMsg('🔴 Recording in progress. Switch to your survey tab and work normally.');

    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);

    statsIntervalRef.current = setInterval(() => fetchStats(sid), 5000);
  }, [extState, surveyId, surveyUrl]);

  // ── 3. Stop Recording ─────────────────────────────────────
  const stopRecording = useCallback(async () => {
    if (recordState !== 'recording') return;
    setRecordState('stopping');
    setStatusMsg('⏳ Finalizing session…');

    clearInterval(timerRef.current);
    clearInterval(statsIntervalRef.current);

    if (mediaRecorderRef.current?.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    await new Promise(r => setTimeout(r, 1500));

    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(EXTENSION_ID, { type: 'STOP_SESSION' }, resolve);
      });
    } catch (_) {}

    try {
      await fetch(`${BACKEND_URL}/api/session/${sessionId}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      console.warn('Could not end session on backend:', e);
    }

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

  // ── 4. Admin API Handlers ─────────────────────────────────
  async function fetchSessions() {
    try {
      const res = await fetch(`${BACKEND_URL}/api/session`);
      if (!res.ok) return;
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
  }

  async function loadSessionDetails(sid) {
    setSelectedSessId(sid);
    setSelectedSess(null);
    setAnalysis(null);
    setPipelineLogs('');
    setRawView('none');
    
    try {
      // 1. Fetch raw logs / details
      const detRes = await fetch(`${BACKEND_URL}/api/session/${sid}`);
      if (detRes.ok) {
        const details = await detRes.json();
        setSelectedSess(details);
      }
      
      // 2. Fetch computed analysis.json if it exists
      const analRes = await fetch(`${BACKEND_URL}/api/session/${sid}/analysis`);
      if (analRes.ok) {
        const data = await analRes.json();
        if (data.found) {
          setAnalysis(data.analysis);
          setPipelineLogs(data.logs || '');
        }
      }
    } catch (err) {
      console.error('Failed to load session details:', err);
    }
  }

  async function runVerification() {
    if (!selectedSessId) return;
    setVerifying(true);
    setAnalysis(null);
    setPipelineLogs('');
    
    try {
      const res = await fetch(`${BACKEND_URL}/api/session/${selectedSessId}/analyze`, {
        method: 'POST'
      });
      const data = await res.json();
      if (res.ok) {
        if (data.success) {
          setAnalysis(data.analysis);
          setPipelineLogs(data.logs || '');
          // Reload sessions list to update stats/state
          fetchSessions();
        }
      } else {
        setPipelineLogs(data.logs || '');
        alert('Verification pipeline error. Check the run logs below.');
      }
    } catch (err) {
      console.error('Analysis error:', err);
      alert('Verification request failed.');
    } finally {
      setVerifying(false);
    }
  }

  async function deleteSession(sid) {
    if (!confirm('Are you sure you want to delete this session? This action is permanent.')) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/session/${sid}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        setSelectedSessId(null);
        setSelectedSess(null);
        setAnalysis(null);
        fetchSessions();
      }
    } catch (err) {
      console.error('Delete failed:', err);
    }
  }

  // ── Formatting ───────────────────────────────────────────
  const formatTime = (secs) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
  };

  const formatDate = (isoStr) => {
    if (!isoStr) return '';
    const date = new Date(isoStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const isRecording = recordState === 'recording';
  const canStart    = extState === 'ready' && (recordState === 'idle' || recordState === 'done');
  const canStop     = isRecording;

  // Filter sessions in sidebar
  const filteredSessions = sessions.filter(s => 
    s.sessionId.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (s.surveyId || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="app-logo">
          <div className="logo-icon">🔬</div>
          <div>
            <div className="logo-text">Market Research Tracker</div>
            <div className="logo-sub">Session Analyzer Console</div>
          </div>
        </div>
        <div className="header-badge">Admin Dashboard</div>
      </header>

      {/* Tabs */}
      <div className="tabs-nav">
        <button 
          className={`tab-btn ${activeTab === 'recorder' ? 'active' : ''}`}
          onClick={() => setActiveTab('recorder')}
        >
          🎥 Recorder Bridge
        </button>
        <button 
          className={`tab-btn ${activeTab === 'admin' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('admin');
            fetchSessions();
          }}
        >
          📊 Admin Verification Dashboard
        </button>
      </div>

      <main className="main" style={{ maxWidth: activeTab === 'admin' ? '1200px' : '720px', width: '100%' }}>
        
        {/* TAB 1: RECORDER */}
        {activeTab === 'recorder' && (
          <>
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

            {/* Session ID Banner */}
            {sessionId && (
              <div className="session-banner">
                <span className="session-banner-label">Active Session</span>
                <span className="session-banner-id">{sessionId}</span>
              </div>
            )}

            {/* Controls */}
            <div className="card controls-card">
              <div className={`timer ${isRecording ? '' : 'idle'}`}>
                {formatTime(elapsed)}
              </div>

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

              <div className="status-msg">
                {error ? <span className="error">{error}</span> : statusMsg}
              </div>

              {extState === 'no_extension' && (
                <button onClick={pingExtension} className="btn-secondary">
                  🔄 Retry Detection
                </button>
              )}
            </div>

            {/* Stats Bar */}
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
          </>
        )}

        {/* TAB 2: ADMIN VERIFICATION PANEL */}
        {activeTab === 'admin' && (
          <div className="admin-grid">
            
            {/* Sidebar: Session Directory */}
            <aside className="sidebar card">
              <div className="card-title">Session Recordings</div>
              <input 
                type="text" 
                placeholder="Search Survey or Session ID..."
                className="search-input"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              <div className="session-list">
                {filteredSessions.length === 0 ? (
                  <div className="status-msg" style={{ padding: '20px 0' }}>No sessions found.</div>
                ) : (
                  filteredSessions.map((s) => (
                    <button 
                      key={s.sessionId}
                      className={`session-item ${selectedSessId === s.sessionId ? 'selected' : ''}`}
                      onClick={() => loadSessionDetails(s.sessionId)}
                    >
                      <div className="session-item-header">
                        <span className="session-item-id">{s.sessionId.substring(0, 8)}...</span>
                        <span className="session-item-date">{formatDate(s.startTime)}</span>
                      </div>
                      <div className="session-item-survey">{s.surveyId}</div>
                      <div className="session-item-meta">
                        <span>📄 {s.pageCount} page(s)</span>
                        <span>🖱️ {s.eventCount} event(s)</span>
                        <span>🎬 {s.videoChunks} chunk(s)</span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </aside>

            {/* Main Detail View Panel */}
            <section className="detail-view">
              {!selectedSessId ? (
                <div className="card placeholder-card">
                  <div className="placeholder-icon">📊</div>
                  <div>Select a recording session from the directory sidebar to verify outputs.</div>
                </div>
              ) : (
                <>
                  {/* Session Overview Card */}
                  <div className="card">
                    <div className="detail-header">
                      <div>
                        <div className="card-title" style={{ marginBottom: '4px' }}>Active Session Inspect</div>
                        <h2 className="session-banner-id" style={{ fontSize: '16px', margin: '4px 0' }}>{selectedSessId}</h2>
                        <div className="session-item-date">Started: {selectedSess ? formatDate(selectedSess.session?.startTime) : 'Loading...'}</div>
                      </div>
                      <div className="header-actions">
                        <button 
                          className="btn-primary" 
                          onClick={runVerification} 
                          disabled={verifying}
                        >
                          {verifying ? (
                            <>
                              <div className="spinner" style={{ width: '12px', height: '12px', borderTopColor: '#fff' }} />
                              Verifying...
                            </>
                          ) : (
                            <>⚙️ Run Verification</>
                          )}
                        </button>
                        <button className="btn-secondary" style={{ borderColor: 'var(--red)', color: 'var(--red)' }} onClick={() => deleteSession(selectedSessId)}>
                          🗑️ Delete
                        </button>
                      </div>
                    </div>

                    {selectedSess && (
                      <div className="survey-grid" style={{ marginTop: '20px', borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
                        <div className="survey-field">
                          <div className="field-label">Survey ID</div>
                          <div className="field-value mono">{selectedSess.session?.surveyId}</div>
                        </div>
                        <div className="survey-field">
                          <div className="field-label">Duration</div>
                          <div className="field-value">{selectedSess.session?.duration || 0}s</div>
                        </div>
                        <div className="survey-field" style={{ gridColumn: '1 / -1' }}>
                          <div className="field-label">Survey URL</div>
                          <div className="field-value url" onClick={() => window.open(selectedSess.session?.surveyUrl, '_blank')}>
                            {selectedSess.session?.surveyUrl}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Verification Output Results */}
                  <div className="card">
                    <div className="card-title">Survey Question & Answer Verification</div>
                    
                    {verifying && (
                      <div className="placeholder-card">
                        <div className="spinner" style={{ width: '40px', height: '40px', borderWidth: '3px', marginBottom: '12px' }} />
                        <div className="status-msg">
                          <p className="highlight">Running Extraction Engine...</p>
                          <p style={{ fontSize: '11px', marginTop: '4px' }}>Layer 1 Heuristics → Layer 2 Click Correlator → Layer 3 Local Llama 3.2 Vision Fallback</p>
                        </div>
                      </div>
                    )}

                    {!verifying && !analysis && (
                      <div className="placeholder-card" style={{ borderStyle: 'solid' }}>
                        <div className="placeholder-icon">⚙️</div>
                        <div style={{ marginBottom: '12px' }}>This session has not been verified yet.</div>
                        <button className="btn-primary" onClick={runVerification}>Run Extraction Pipeline</button>
                      </div>
                    )}

                    {!verifying && pipelineLogs && (
                      <div style={{ marginTop: '16px', marginBottom: '16px' }}>
                        <div className="card-title" style={{ fontSize: '10px', marginBottom: '8px', color: 'var(--emerald)' }}>Pipeline Run Output</div>
                        <pre className="log-terminal">{pipelineLogs}</pre>
                      </div>
                    )}

                    {!verifying && analysis && (
                      <div>
                        {/* Summary Block */}
                        <div className="session-banner" style={{ marginBottom: '20px', background: 'rgba(16, 185, 129, 0.04)', borderColor: 'rgba(16, 185, 129, 0.2)' }}>
                          <span className="session-banner-label" style={{ color: 'var(--emerald)' }}>Pipeline Verification Success</span>
                          <div style={{ display: 'flex', gap: '20px' }}>
                            <div className="session-item-meta">
                              <strong>Completion Rate:</strong> <span style={{ color: 'var(--emerald)', fontWeight: '700' }}>{analysis.summary?.completionRate}</span>
                            </div>
                            <div className="session-item-meta">
                              <strong>Q&A Pairs:</strong> {analysis.summary?.answeredQuestions} / {analysis.summary?.totalQuestions}
                            </div>
                          </div>
                        </div>

                        {/* Page & QA Grid */}
                        {analysis.pages?.length === 0 ? (
                          <div className="status-msg">No snapshots or questions detected on the pages.</div>
                        ) : (
                          analysis.pages.map((page, pIdx) => (
                            <div key={pIdx} style={{ marginBottom: '24px' }}>
                              <div className="field-label" style={{ marginBottom: '8px' }}>Page URL: <span className="mono" style={{ textTransform: 'none', color: 'var(--sky)' }}>{page.url}</span></div>
                              
                              <div className="qa-grid">
                                {page.questions?.length === 0 ? (
                                  <div className="qa-card" style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>No questions parsed on this page.</div>
                                ) : (
                                  page.questions.map((q, qIdx) => (
                                    <div key={qIdx} className={`qa-card confidence-${q.confidence}`}>
                                      
                                      <div className="qa-header">
                                        <h4 className="qa-title">{q.questionText}</h4>
                                        <div className="qa-badges">
                                          <span className={`badge badge-${q.confidence}`}>{q.confidence} conf</span>
                                          <span className="badge badge-source">{q.source}</span>
                                        </div>
                                      </div>

                                      {q.options && q.options.length > 0 && (
                                        <div className="qa-options">
                                          {q.options.map((opt, oIdx) => (
                                            <span 
                                              key={oIdx} 
                                              className={`qa-option ${q.selectedAnswer === opt || (q.selectedAnswer && q.selectedAnswer.includes(opt)) ? 'selected' : ''}`}
                                            >
                                              {opt}
                                            </span>
                                          ))}
                                        </div>
                                      )}

                                      <div className="qa-answer-block">
                                        <div className="qa-answer-label">Extracted Selected Answer</div>
                                        <div className="qa-answer-value">
                                          {q.selectedAnswer ? q.selectedAnswer : <span style={{ color: 'var(--text-muted)' }}>[No Answer Detected]</span>}
                                        </div>
                                      </div>

                                      {q.reasoning && (
                                        <div className="qa-reasoning">
                                          <span>💡</span>
                                          <span>{q.reasoning}</span>
                                        </div>
                                      )}

                                    </div>
                                  ))
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                  {/* Raw Data Inspector Toggle */}
                  <div className="card">
                    <div className="card-title">Developer Raw Logs Inspector</div>
                    <div className="flex gap-2" style={{ marginBottom: '14px', flexWrap: 'wrap' }}>
                      <button className={`btn-secondary ${rawView === 'session' ? 'btn-primary' : ''}`} onClick={() => setRawView(rawView === 'session' ? 'none' : 'session')}>
                        session.json
                      </button>
                      <button className={`btn-secondary ${rawView === 'pages' ? 'btn-primary' : ''}`} onClick={() => setRawView(rawView === 'pages' ? 'none' : 'pages')}>
                        pages.json
                      </button>
                      <button className={`btn-secondary ${rawView === 'events' ? 'btn-primary' : ''}`} onClick={() => setRawView(rawView === 'events' ? 'none' : 'events')}>
                        events.json
                      </button>
                      {analysis && (
                        <button className={`btn-secondary ${rawView === 'analysis' ? 'btn-primary' : ''}`} onClick={() => setRawView(rawView === 'analysis' ? 'none' : 'analysis')}>
                          analysis.json
                        </button>
                      )}
                    </div>

                    {rawView !== 'none' && (
                      <div className="json-viewer">
                        <pre className="json-block">
                          {rawView === 'session' && JSON.stringify(selectedSess?.session, null, 2)}
                          {rawView === 'pages' && JSON.stringify(selectedSess?.pages, null, 2)}
                          {rawView === 'events' && JSON.stringify(selectedSess?.events, null, 2)}
                          {rawView === 'analysis' && JSON.stringify(analysis, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </>
              )}
            </section>
          </div>
        )}

      </main>
    </div>
  );
}
