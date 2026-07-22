import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { BACKEND_URL } from '../config';

export default function AdminPage() {
  const { sessionId: routeSessionId } = useParams();
  const navigate = useNavigate();

  const [sessions, setSessions]             = useState([]);
  const [searchTerm, setSearchTerm]         = useState('');
  const [selectedSess, setSelectedSess]     = useState(null);
  const [analysis, setAnalysis]             = useState(null);
  const [pipelineLogs, setPipelineLogs]     = useState('');
  const [showAllPages, setShowAllPages] = useState(false);
  const [verifying, setVerifying]           = useState(false);
  const [rawView, setRawView]               = useState('none'); // none | session | events | pages | analysis

  // Fetch session directory on mount
  useEffect(() => {
    fetchSessions();
  }, []);

  // Sync selected session when route changes or directory loads
  useEffect(() => {
    if (routeSessionId) {
      loadSessionDetails(routeSessionId);
    } else {
      setSelectedSess(null);
      setAnalysis(null);
      setPipelineLogs('');
    }
  }, [routeSessionId]);

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
    setSelectedSess(null);
    setAnalysis(null);
    setPipelineLogs('');
    setRawView('none');

    try {
      const detRes = await fetch(`${BACKEND_URL}/api/session/${sid}`);
      if (detRes.ok) {
        const details = await detRes.json();
        setSelectedSess(details);
      }

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
    if (!routeSessionId) return;
    setVerifying(true);
    setAnalysis(null);
    setPipelineLogs('🚀 Executing verification pipeline...');

    try {
      const token = localStorage.getItem('recordx_token');
      const res = await fetch(`${BACKEND_URL}/api/session/${routeSessionId}/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        }
      });

      const data = await res.json().catch(() => ({ 
        error: `HTTP ${res.status} ${res.statusText}`, 
        logs: 'Server returned non-JSON response.' 
      }));

      if (res.ok && data.success) {
        setAnalysis(data.analysis);
        setPipelineLogs(data.logs || '');
        fetchSessions();
      } else {
        setPipelineLogs(data.logs || data.error || 'Pipeline execution failed.');
        alert('Verification error: ' + (data.error || 'Check output logs below.'));
      }
    } catch (err) {
      console.error('Analysis error:', err);
      const msg = `Connection Error: ${err.message}\nTarget URL: ${BACKEND_URL}/api/session/${routeSessionId}/analyze\n\nPossible Causes:\n1. Server SSL/HTTPS mismatch or Nginx timeout\n2. Backend server is offline or python3/bs4 missing on server.`;
      setPipelineLogs(msg);
      alert(`Server Connection Error: ${err.message}\nPlease check backend server logs or Nginx timeout settings.`);
    } finally {
      setVerifying(false);
    }
  }

  async function deleteSession(sid) {
    if (!confirm('Are you sure you want to delete this session? This action cannot be undone.')) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/session/${sid}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        navigate('/admin');
        fetchSessions();
      }
    } catch (err) {
      console.error('Delete failed:', err);
    }
  }

  const formatDate = (isoStr) => {
    if (!isoStr) return '';
    const date = new Date(isoStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const filteredSessions = sessions.filter(s =>
    s.sessionId.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (s.surveyId || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="page-wrapper admin-page">
      <div className="admin-grid">
        
        {/* Sidebar: Session Directory */}
        <aside className="sidebar card">
          <div className="card-title">
            <span className="icon">📁</span> Session Directory ({filteredSessions.length})
          </div>
          
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
                  className={`session-item ${routeSessionId === s.sessionId ? 'selected' : ''}`}
                  onClick={() => navigate(`/admin/session/${s.sessionId}`)}
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

        {/* Main Detail Inspection Panel */}
        <section className="detail-view">
          {!routeSessionId ? (
            <div className="card placeholder-card">
              <div className="placeholder-icon">📊</div>
              <div>Select a recording session from the directory to inspect data and run verification.</div>
            </div>
          ) : (
            <>
              {/* Session Header Card */}
              <div className="card">
                <div className="detail-header">
                  <div>
                    <div className="card-title" style={{ marginBottom: '4px' }}>Session Verification Inspection</div>
                    <h2 className="session-banner-id" style={{ fontSize: '15px', margin: '4px 0' }}>{routeSessionId}</h2>
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
                    <button className="btn-secondary danger" onClick={() => deleteSession(routeSessionId)}>
                      🗑️ Delete
                    </button>
                  </div>
                </div>

                {selectedSess && (
                  <div className="survey-grid" style={{ marginTop: '20px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                    <div className="survey-field">
                      <div className="field-label">Survey ID</div>
                      <div className="field-value mono">{selectedSess.session?.surveyId}</div>
                    </div>
                    <div className="survey-field">
                      <div className="field-label">Duration</div>
                      <div className="field-value">{selectedSess.session?.duration || 0}s</div>
                    </div>
                    <div className="survey-field" style={{ gridColumn: '1 / -1' }}>
                      <div className="field-label">Survey Target URL</div>
                      <div className="field-value url" onClick={() => window.open(selectedSess.session?.surveyUrl, '_blank')}>
                        <span>{selectedSess.session?.surveyUrl}</span>
                        <span className="url-arrow">↗</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Verification Output Results */}
              <div className="card">
                <div className="card-title">
                  <span className="icon">🔍</span> Survey Question & Answer Verification
                </div>

                {verifying && (
                  <div className="placeholder-card">
                    <div className="spinner" style={{ width: '40px', height: '40px', borderWidth: '3px', marginBottom: '12px' }} />
                    <div className="status-msg">
                      <p className="highlight">Running Extraction Engine...</p>
                      <p style={{ fontSize: '11px', marginTop: '4px' }}>Layer 1 Heuristics → Layer 2 Click Correlator → Layer 3 Local Vision Fallback</p>
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
                    <div className="terminal-wrapper">
                      <div className="terminal-header">
                        <div className="terminal-dots">
                          <span className="dot dot-red"></span>
                          <span className="dot dot-yellow"></span>
                          <span className="dot dot-green"></span>
                        </div>
                        <span className="terminal-title">Extraction Pipeline Output</span>
                      </div>
                      <pre className="log-terminal">{pipelineLogs}</pre>
                    </div>
                  </div>
                )}

                {!verifying && analysis && (
                  <div>
                    {/* Summary Banner */}
                    <div className="session-banner summary-banner" style={{ marginBottom: '20px' }}>
                      <span className="session-banner-label" style={{ color: 'var(--primary-brand-hover)' }}>Pipeline Verification Success</span>
                      <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
                        <div className="session-item-meta">
                          <strong>Completion Rate:</strong> <span style={{ color: 'var(--primary-brand-hover)', fontWeight: '700' }}>{analysis.summary?.completionRate}</span>
                        </div>
                        <div className="session-item-meta">
                          <strong>Q&A Pairs:</strong> {analysis.summary?.answeredQuestions} / {analysis.summary?.totalQuestions}
                        </div>
                        <button
                          className="copy-pill-btn"
                          onClick={() => setShowAllPages(!showAllPages)}
                        >
                          {showAllPages ? 'Hide Empty Redirect Pages' : `Show All Pages (${analysis.pages?.length || 0})`}
                        </button>
                      </div>
                    </div>

                    {/* Page & QA Grid */}
                    {(() => {
                      const displayPages = showAllPages
                        ? (analysis.pages || [])
                        : (analysis.pages || []).filter(p => p.questions && p.questions.length > 0);

                      if (displayPages.length === 0) {
                        return <div className="status-msg">No questions detected on the active survey pages.</div>;
                      }

                      return displayPages.map((page, pIdx) => (
                        <div key={pIdx} style={{ marginBottom: '24px' }}>
                          <div className="field-label" style={{ marginBottom: '8px' }}>Page URL: <span className="mono" style={{ textTransform: 'none', color: 'var(--primary-brand-hover)' }}>{page.url}</span></div>
                          
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
                                      {q.selectedAnswer || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Unanswered</span>}
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
                      ));
                    })()}
                  </div>
                )}
              </div>

              {/* Developer Raw Logs Inspector */}
              <div className="card">
                <div className="card-title">Developer Raw Logs Inspector</div>
                <div className="flex gap-2" style={{ marginBottom: '14px', flexWrap: 'wrap' }}>
                  <button className={`btn-secondary ${rawView === 'session' ? 'active' : ''}`} onClick={() => setRawView(rawView === 'session' ? 'none' : 'session')}>
                    session.json
                  </button>
                  <button className={`btn-secondary ${rawView === 'pages' ? 'active' : ''}`} onClick={() => setRawView(rawView === 'pages' ? 'none' : 'pages')}>
                    pages.json
                  </button>
                  <button className={`btn-secondary ${rawView === 'events' ? 'active' : ''}`} onClick={() => setRawView(rawView === 'events' ? 'none' : 'events')}>
                    events.json
                  </button>
                  {analysis && (
                    <button className={`btn-secondary ${rawView === 'analysis' ? 'active' : ''}`} onClick={() => setRawView(rawView === 'analysis' ? 'none' : 'analysis')}>
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
    </div>
  );
}
