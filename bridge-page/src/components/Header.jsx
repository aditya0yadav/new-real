import { NavLink } from 'react-router-dom';

export default function Header() {
  return (
    <header className="app-header">
      <div className="header-container">
        <div className="app-logo">
          <div className="logo-icon">🎥</div>
          <div>
            <div className="logo-text">Market Research Tracker</div>
            <div className="logo-sub">Session Recorder & Verification Console</div>
          </div>
        </div>

        <nav className="header-nav">
          <NavLink 
            to="/" 
            end
            className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
          >
            <span className="nav-icon">📹</span>
            <span>Recorder Bridge</span>
          </NavLink>
          <NavLink 
            to="/admin" 
            className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
          >
            <span className="nav-icon">📊</span>
            <span>Admin Dashboard</span>
          </NavLink>
        </nav>

        <div className="header-status">
          <span className="status-dot"></span>
          <span className="status-text">System Active</span>
        </div>
      </div>
    </header>
  );
}
