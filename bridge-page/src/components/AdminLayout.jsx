import { useState } from 'react';
import { NavLink, useLocation, useNavigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { 
  LayoutDashboard, 
  Video, 
  ClipboardList, 
  LogOut, 
  ChevronLeft, 
  ChevronRight, 
  Search, 
  ShieldCheck,
  Bell,
  Globe
} from 'lucide-react';

export default function AdminLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const { user, logout } = useAuth();
  const { lang, toggleLanguage, t } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // Determine breadcrumb title
  const getBreadcrumbs = () => {
    const path = location.pathname;
    if (path === '/' || path === '/dashboard') return [t('console'), t('dashboard')];
    if (path.startsWith('/recorder')) return [t('console'), t('screenRecorder')];
    if (path.startsWith('/admin/session')) return [t('console'), t('sessionDirectory'), t('inspect')];
    if (path.startsWith('/admin')) return [t('console'), t('sessionDirectory')];
    return [t('console'), 'Overview'];
  };

  const breadcrumbs = getBreadcrumbs();

  return (
    <div className={`admin-app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      {/* ── Left Sidebar Navigation ───────────────────────────── */}
      <aside className="app-sidebar">
        <div className="sidebar-top">
          {/* Logo Header */}
          <div className="sidebar-logo">
            <div className="logo-icon-box">
              <ShieldCheck size={22} className="logo-svg" />
            </div>
            {!collapsed && (
              <div className="logo-brand-info">
                <span className="logo-title">{t('brandName')}</span>
                <span className="logo-subtitle">{t('brandSubtitle')}</span>
              </div>
            )}
            <button className="sidebar-toggle-btn" onClick={() => setCollapsed(!collapsed)}>
              {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
            </button>
          </div>

          {/* Navigation Menu Links */}
          <nav className="sidebar-menu">
            <div className="menu-group-label">{!collapsed && 'MODULES'}</div>
            
            <NavLink to="/" end className={({ isActive }) => `menu-item ${isActive ? 'active' : ''}`}>
              <LayoutDashboard size={20} className="menu-icon" />
              {!collapsed && <span className="menu-text">{t('dashboard')}</span>}
            </NavLink>

            <NavLink to="/recorder" className={({ isActive }) => `menu-item ${isActive ? 'active' : ''}`}>
              <Video size={20} className="menu-icon" />
              {!collapsed && <span className="menu-text">{t('screenRecorder')}</span>}
            </NavLink>

            <NavLink to="/admin" className={({ isActive }) => `menu-item ${isActive ? 'active' : ''}`}>
              <ClipboardList size={20} className="menu-icon" />
              {!collapsed && <span className="menu-text">{t('sessionDirectory')}</span>}
            </NavLink>
          </nav>
        </div>

        {/* Sidebar Footer User Profile */}
        <div className="sidebar-bottom">
          <div className="sidebar-user-card">
            <div className="user-left">
              <img 
                src={user?.avatar || "https://api.dicebear.com/7.x/notionists/svg?seed=Admin&backgroundColor=10B981"} 
                alt="Avatar" 
                className="user-avatar" 
              />
              {!collapsed && (
                <div className="user-details">
                  <span className="user-name">{user?.name || 'Administrator'}</span>
                  <span className="user-role">{user?.role || 'Admin'}</span>
                </div>
              )}
            </div>
            <button className="logout-btn" onClick={handleLogout} title={t('signOut')}>
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main Content Container ────────────────────────────── */}
      <div className="app-main-content">
        {/* Top Navbar */}
        <header className="app-topbar">
          <div className="topbar-left">
            <div className="breadcrumb">
              {breadcrumbs.map((crumb, idx) => (
                <span key={idx} className="breadcrumb-segment">
                  {idx > 0 && <span className="breadcrumb-slash">/</span>}
                  <span className={`crumb-text ${idx === breadcrumbs.length - 1 ? 'current' : ''}`}>{crumb}</span>
                </span>
              ))}
            </div>
          </div>

          <div className="topbar-right">
            <div className="topbar-search">
              <Search size={16} className="search-svg" />
              <input type="text" placeholder="Search sessions..." className="topbar-search-input" />
            </div>

            {/* Language Toggle Button */}
            <button 
              className="copy-pill-btn" 
              onClick={toggleLanguage}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
              title="Toggle Language"
            >
              <Globe size={14} />
              <span>{lang === 'en' ? '中文' : 'English'}</span>
            </button>

            <div className="topbar-status-pill">
              <span className="status-dot"></span>
              <span className="status-label">{t('backendOnline')}</span>
            </div>

            <div className="topbar-actions">
              <button className="icon-action-btn" title="Notifications">
                <Bell size={18} />
              </button>
            </div>
          </div>
        </header>

        {/* Page Content Outlet */}
        <div className="page-content-body">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
