import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BACKEND_URL } from '../config';
import { useLanguage } from '../context/LanguageContext';
import { Video, ClipboardList, CheckCircle2, ShieldCheck, ArrowRight, Play, RefreshCw } from 'lucide-react';

export default function DashboardPage() {
  const { t } = useLanguage();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading]   = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchDashboardData();
  }, []);

  async function fetchDashboardData() {
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/session`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch (err) {
      console.error('Failed to load dashboard sessions:', err);
    } finally {
      setLoading(false);
    }
  }

  const totalSessions  = sessions.length;
  const totalEvents    = sessions.reduce((acc, s) => acc + (s.eventCount || 0), 0);
  const totalChunks    = sessions.reduce((acc, s) => acc + (s.videoChunks || 0), 0);

  const formatDate = (isoStr) => {
    if (!isoStr) return '--';
    const date = new Date(isoStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="page-wrapper dashboard-page">
      
      {/* Hero Welcome Banner */}
      <div className="dashboard-hero-card">
        <div className="hero-content">
          <h1 className="hero-title">{t('heroTitle')}</h1>
          <p className="hero-desc">
            {t('heroDesc')}
          </p>
          <div className="hero-actions">
            <button className="hero-btn primary" onClick={() => navigate('/recorder')}>
              <Play size={16} />
              <span>{t('launchRecorder')}</span>
            </button>
            <button className="hero-btn secondary" onClick={() => navigate('/admin')}>
              <ClipboardList size={16} />
              <span>{t('browseDirectory')}</span>
            </button>
          </div>
        </div>
        <div className="hero-badge-box">
          <ShieldCheck size={48} className="hero-shield-icon" />
        </div>
      </div>

      {/* KPI Metrics Cards */}
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">{t('totalSessions')}</span>
            <div className="metric-icon-box green">
              <ClipboardList size={20} />
            </div>
          </div>
          <div className="metric-value">{totalSessions}</div>
          <div className="metric-sub text-green">{t('recordedSessionsSub')}</div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">{t('userEvents')}</span>
            <div className="metric-icon-box blue">
              <CheckCircle2 size={20} />
            </div>
          </div>
          <div className="metric-value">{totalEvents}</div>
          <div className="metric-sub text-muted">{t('capturedEventsSub')}</div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">{t('videoChunks')}</span>
            <div className="metric-icon-box violet">
              <Video size={20} />
            </div>
          </div>
          <div className="metric-value">{totalChunks}</div>
          <div className="metric-sub text-muted">{t('webmChunksSub')}</div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">{t('systemStatus')}</span>
            <div className="metric-icon-box green">
              <ShieldCheck size={20} />
            </div>
          </div>
          <div className="metric-value text-green">{t('active')}</div>
          <div className="metric-sub text-green">{t('systemStatusSub')}</div>
        </div>
      </div>

      {/* Recent Sessions Data Table */}
      <div className="card table-card">
        <div className="table-header">
          <div>
            <h3 className="table-title">{t('recentRecordings')}</h3>
            <p className="table-sub">{t('clickToInspect')}</p>
          </div>
          <button className="refresh-btn" onClick={fetchDashboardData}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            <span>{t('refresh')}</span>
          </button>
        </div>

        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('sessionId')}</th>
                <th>{t('surveyId')}</th>
                <th>{t('recordedTime')}</th>
                <th>{t('duration')}</th>
                <th>{t('pageCount')}</th>
                <th>{t('chunks')}</th>
                <th>{t('action')}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 ? (
                <tr>
                  <td colSpan="7" className="table-empty">
                    No recorded sessions found. Click "{t('launchRecorder')}" to start.
                  </td>
                </tr>
              ) : (
                sessions.slice(0, 10).map((s) => (
                  <tr key={s.sessionId} className="table-row" onClick={() => navigate(`/admin/session/${s.sessionId}`)}>
                    <td className="font-mono text-green">{s.sessionId.substring(0, 12)}...</td>
                    <td className="font-semibold">{s.surveyId || 'N/A'}</td>
                    <td>{formatDate(s.startTime)}</td>
                    <td>{s.duration || 0}s</td>
                    <td>{s.pageCount || 0} pages</td>
                    <td>
                      <span className="badge badge-green">{s.videoChunks || 0} chunks</span>
                    </td>
                    <td>
                      <button 
                        className="table-action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/admin/session/${s.sessionId}`);
                        }}
                      >
                        <span>{t('inspect')}</span>
                        <ArrowRight size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
